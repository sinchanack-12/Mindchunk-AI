from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import json
import re
import time
import random
import pypdf
import docx
from pptx import Presentation
from dotenv import load_dotenv
from google import genai
from google.genai import types

# Load environment variables from backend/.env
load_dotenv()

app = FastAPI(title="MindChunk AI API Engine")

API_KEY = os.getenv("GEMINI_API_KEY", "")
client = genai.Client(api_key=API_KEY) if API_KEY else None

# Enable CORS for Next.js frontend.
# NOTE: allow_origins=["*"] together with allow_credentials=True is invalid
# per the CORS spec and browsers will reject it. List explicit origins instead.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active stable model identifier for Google GenAI SDK.
# Newer / more popular models can hit sustained 503 "high demand" errors,
# especially on the free tier. MODEL_FALLBACKS lists other current models to
# try, in order, if the primary model keeps failing even after retries.
#
# NOTE: Google's model lineup changes fast (models get retired every few
# months). If you start seeing 404 "no longer available" errors again,
# check https://ai.google.dev/gemini-api/docs/changelog for current model
# IDs and update these two lines.
MODEL_NAME = 'gemini-3.6-flash'
MODEL_FALLBACKS = ['gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest']


class YoutubeRequest(BaseModel):
    url: str


class RepairRequest(BaseModel):
    topic_id: str


@app.get("/")
def home():
    return {"status": "online", "message": "MindChunk AI API Engine Running"}


# Errors worth retrying: temporary overload / rate limit / transient server
# issues. Anything else (bad API key, invalid model name, bad request) will
# fail the same way every time, so retrying it is pointless -- fail fast.
RETRYABLE_STATUS_CODES = {429, 500, 503, 504}


def _is_retryable_error(error_text: str) -> bool:
    return any(
        f"'code': {code}" in error_text or f'"code": {code}' in error_text
        for code in RETRYABLE_STATUS_CODES
    ) or "UNAVAILABLE" in error_text or "RESOURCE_EXHAUSTED" in error_text


def _call_with_retry(model_name: str, max_attempts: int, base_delay_seconds: float,
                      **generate_content_kwargs):
    """
    Calls generate_content on a single model, retrying with exponential
    backoff (plus jitter) on transient errors. Raises on the final failure.
    """
    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            return client.models.generate_content(model=model_name, **generate_content_kwargs)
        except Exception as e:
            last_error = e
            error_text = str(e)

            if not _is_retryable_error(error_text) or attempt == max_attempts:
                raise

            delay = base_delay_seconds * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            print(f"[{model_name}] Gemini call failed (attempt {attempt}/{max_attempts}), "
                  f"retrying in {delay:.1f}s. Error: {error_text}")
            time.sleep(delay)

    raise last_error  # unreachable, keeps type-checkers happy


def call_gemini_with_retry(**generate_content_kwargs):
    """
    Tries the primary model (MODEL_NAME) with retries + exponential backoff
    for transient errors (e.g. 503 UNAVAILABLE under high demand). If a
    model keeps failing -- whether that's temporary overload OR a hard
    failure like the model being deprecated/renamed/not found -- this moves
    on to the next model in MODEL_FALLBACKS, so ONE model having a bad day
    (or being retired by Google) doesn't take the whole app down.
    Only the FINAL model's error is raised if every single one fails.
    """
    models_to_try = [MODEL_NAME] + MODEL_FALLBACKS
    last_error = None

    for i, model_name in enumerate(models_to_try):
        is_last_model = (i == len(models_to_try) - 1)
        try:
            # Retryable errors (503/429/etc) get up to 4 attempts on THIS
            # model. Non-retryable errors (404 not found, deprecated, bad
            # request) fail in 1 attempt -- no point retrying the exact
            # same broken call -- and we move straight to the next model.
            return _call_with_retry(
                model_name=model_name,
                max_attempts=4,
                base_delay_seconds=1.5,
                **generate_content_kwargs,
            )
        except Exception as e:
            last_error = e
            error_text = str(e)

            if not is_last_model:
                reason = "exhausted retries" if _is_retryable_error(error_text) else "hard failure"
                print(f"[{model_name}] {reason}, falling back to "
                      f"'{models_to_try[i + 1]}'. Error: {error_text}")
            # else: this was the last model in the list -- fall through
            # to the loop end and raise below.

    # Every model in the chain failed. Raise the last error so the caller's
    # except block can log it and return the graceful fallback response.
    raise last_error


def safe_json_parse(raw_text: str):
    """
    Gemini is instructed to return raw JSON, but occasionally wraps it in
    Markdown code fences. Strip those before parsing so we don't crash on
    a perfectly valid response.
    """
    cleaned = raw_text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return json.loads(cleaned)


# Extract text cleanly across PDF, PPTX, and DOCX formats
def extract_text_from_file(file: UploadFile) -> str:
    filename = (file.filename or "").lower()
    extracted_text = ""

    try:
        if filename.endswith(".pdf"):
            pdf_reader = pypdf.PdfReader(file.file)
            for page in pdf_reader.pages:
                extracted_text += (page.extract_text() or "") + "\n"

        elif filename.endswith(".pptx"):
            prs = Presentation(file.file)
            for slide in prs.slides:
                for shape in slide.shapes:
                    if hasattr(shape, "text"):
                        extracted_text += shape.text + "\n"

        elif filename.endswith(".docx"):
            doc = docx.Document(file.file)
            for para in doc.paragraphs:
                extracted_text += para.text + "\n"

    except Exception as e:
        print(f"Error extracting text from {filename}: {e}")
        # Re-raise so the caller knows extraction genuinely failed,
        # instead of silently returning an empty string.
        raise

    return extracted_text.strip()


# How much extracted text we send to the model. gemini-3.6-flash supports a
# 1M-token context window, so this is generous headroom (roughly 40-50k
# tokens) rather than the old 30,000-CHARACTER cutoff that was truncating
# most real documents after just a few pages.
MAX_SOURCE_CHARS = 150000

# Shared instructions for how thoroughly to cover the source material and
# the exact JSON shape we need back, reused across the PDF and YouTube
# endpoints so both behave consistently.
COVERAGE_INSTRUCTIONS = """
Generate a JSON object with 4 keys: "topics", "summaries", "quizzes", "flashcards".

Do NOT limit yourself to a small, fixed number of items. Instead, scale the
amount of content to how much material is actually in the source: a short
document might only need 6-8 summary points, while a long, dense document
should get 20-30+. Your goal is that a student who only reads your output,
and never opens the original source, would still learn every important
concept, definition, mechanism, formula, and distinction covered in it.
Do not omit a concept just to keep the list short. Do not pad with trivial
or repetitive items just to reach a number.

1. "topics": A sequential list of topic objects forming a dependency tree
   that covers every major section/theme of the material (typically
   6-15 items depending on length). Each item must have:
   - "id": short string like "t1", "t2", etc.
   - "title": short topic name
   - "status": one of "foundational", "advanced", "mastery"
   - "depth": integer 0-3 indicating how prerequisite-dependent it is
     (0 = foundational entry point, higher = builds on earlier topics)

2. "summaries": A comprehensive list of bullet-point statements (typically
   15-30+ depending on length) explaining the core concepts, definitions,
   mechanisms, formulas, and key takeaways. Each bullet should be a
   complete, self-contained, specific statement -- not a vague fragment.

3. "quizzes": As many multiple-choice questions as needed to test EVERY
   major concept from "topics" and "summaries" (typically 10-25+ depending
   on length -- do not stop at a small round number if the material
   supports more). Each item must have:
   - "topic": which topic/concept this tests
   - "question": the question text
   - "options": array of exactly 4 answer choices
   - "answer": the correct option, copied EXACTLY as it appears in "options"
   - "explanation": 2-4 sentences explaining *why* the correct answer is
     right, with enough context that a student who got it wrong (or picked
     any of the other options) understands the underlying concept and why
     the other options are incorrect or incomplete.

4. "flashcards": A list of flashcards (typically 15-30+ depending on
   length) covering key terms, definitions, formulas, and facts worth
   memorizing. Each item must have:
   - "term": the word, phrase, or short question (front of card)
   - "definition": the concise, clear answer/explanation (back of card)

Return ONLY a raw valid JSON object. No Markdown formatting, no backticks,
no commentary before or after the JSON.
"""


@app.post("/api/ingest/pdf")
async def ingest_pdf(file: UploadFile = File(...)):
    try:
        extracted_text = extract_text_from_file(file)

        if not extracted_text:
            extracted_text = f"Document title: {file.filename}."

        truncated_text = extracted_text[:MAX_SOURCE_CHARS]
        was_truncated = len(extracted_text) > MAX_SOURCE_CHARS

        prompt = f"""
        You are an AI study assistant analyzing a document named '{file.filename}'.
        Analyze the ENTIRE text below thoroughly and comprehensively -- do not
        skim or only cover the first few sections.

        {COVERAGE_INSTRUCTIONS}

        Document Text{" (truncated to the first portion due to length)" if was_truncated else ""}:
        {truncated_text}
        """

        if not client:
            raise Exception("GEMINI_API_KEY is missing in backend/.env file.")

        response = call_gemini_with_retry(
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=65536,
            )
        )

        data = safe_json_parse(response.text)
        data["filename"] = file.filename
        data.setdefault("flashcards", [])
        return data

    except Exception as e:
        print(f"DEBUG ERROR: {e}")
        # Return fallback structured data on error to prevent frontend crash
        return {
            "filename": file.filename,
            "topics": [
                {"id": "t1", "title": f"1. Overview of {file.filename}", "status": "foundational", "depth": 0},
                {"id": "t2", "title": f"2. Core Mechanics in {file.filename}", "status": "foundational", "depth": 1},
                {"id": "t3", "title": "3. Advanced Principles", "status": "advanced", "depth": 2},
            ],
            "summaries": [
                f"Error processing document with AI: {str(e)}",
                "Please verify your GEMINI_API_KEY in backend/.env.",
                "Ensure Uvicorn backend was restarted after saving code changes."
            ],
            "quizzes": [
                {
                    "topic": file.filename,
                    "question": f"What is the primary subject of {file.filename}?",
                    "options": ["Core Principles", "Secondary Mechanics", "Historical Background", "None"],
                    "answer": "Core Principles",
                    "explanation": "This is placeholder fallback data shown because the AI request failed -- see the error above."
                }
            ],
            "flashcards": []
        }


@app.post("/api/ingest/youtube")
async def ingest_youtube(req: YoutubeRequest):
    try:
        if not client:
            raise Exception("GEMINI_API_KEY missing")

        prompt = f"""
        Watch and analyze this YouTube video in full, start to finish --
        do not just summarize the intro or first few minutes.

        {COVERAGE_INSTRUCTIONS}
        """

        # Pass the YouTube URL directly as video input so Gemini analyzes the
        # actual video content instead of guessing from the URL text alone.
        response = call_gemini_with_retry(
            contents=types.Content(
                parts=[
                    types.Part(file_data=types.FileData(file_uri=req.url)),
                    types.Part(text=prompt),
                ]
            ),
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=65536,
            )
        )
        data = safe_json_parse(response.text)
        data.setdefault("flashcards", [])
        return data

    except Exception as e:
        print(f"DEBUG ERROR (youtube): {e}")
        return {
            "url": req.url,
            "topics": [{"id": "t1", "title": "1. Core Video Thesis", "status": "foundational", "depth": 0}],
            "summaries": [f"Parsed video source: {req.url}", f"Note: {str(e)}"],
            "quizzes": [],
            "flashcards": []
        }


@app.post("/api/repair-kit")
async def repair_kit(req: RepairRequest):
    try:
        if not client:
            raise Exception("GEMINI_API_KEY missing")

        prompt = (
            f"Generate a 60-second micro-lesson repair kit for the topic "
            f"'{req.topic_id}' in exactly 3 concise sentences, aimed at a "
            f"student who is struggling with this specific concept."
        )
        response = call_gemini_with_retry(
            contents=prompt
        )
        return {"topic_id": req.topic_id, "repair_lesson": response.text.strip()}
    except Exception as e:
        print(f"DEBUG ERROR (repair-kit): {e}")
        return {
            "topic_id": req.topic_id,
            "repair_lesson": "60-Second Micro Lesson: Foundational concepts serve as core building blocks. Review key representations before moving to advanced topics."
        }
