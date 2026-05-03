"""
Voice Module
=============
Speech-to-Text (STT) and Text-to-Speech (TTS) for Jarvis.

STT: Uses SpeechRecognition with Google Web Speech API (online)
     or Whisper via OpenAI (if API key is set).
TTS: Uses pyttsx3 (offline) with gTTS (online) as fallback.
"""

import io
import logging
import os
import tempfile
import threading

import config

logger = logging.getLogger(__name__)

# ─── TTS Engine ──────────────────────────────────────────────────────────

_tts_engine = None
_tts_lock = threading.Lock()


def _init_tts():
    """Initialize pyttsx3 TTS engine (offline)."""
    global _tts_engine
    if _tts_engine is not None:
        return _tts_engine
    try:
        import pyttsx3
        _tts_engine = pyttsx3.init()
        _tts_engine.setProperty("rate", 160)  # words per minute
        _tts_engine.setProperty("volume", 1.0)

        # Try to pick a natural-sounding voice
        voices = _tts_engine.getProperty("voices")
        for v in voices:
            if "english" in v.name.lower():
                _tts_engine.setProperty("voice", v.id)
                break

        logger.info("pyttsx3 TTS engine initialized")
        return _tts_engine
    except Exception as e:
        logger.warning("pyttsx3 init failed: %s", e)
        return None


def speak(text: str) -> str:
    """
    Speak the given text aloud.

    Tries pyttsx3 (offline) first, falls back to gTTS (online).

    Parameters
    ----------
    text : str
        The text to speak.

    Returns
    -------
    str
        "pyttsx3", "gtts", or "error" indicating which engine was used.
    """
    if not text:
        return "error"

    # Try pyttsx3 (offline, synchronous)
    with _tts_lock:
        engine = _init_tts()
        if engine:
            try:
                engine.say(text)
                engine.runAndWait()
                logger.info("Spoke (pyttsx3): '%s...'", text[:50])
                return "pyttsx3"
            except Exception as e:
                logger.warning("pyttsx3 speak failed: %s", e)

    # Fallback: gTTS (online, saves to file and plays)
    try:
        from gtts import gTTS
        tts = gTTS(text=text, lang="en", slow=False)
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            tts.save(f.name)
            _play_audio(f.name)
            os.unlink(f.name)
        logger.info("Spoke (gTTS): '%s...'", text[:50])
        return "gtts"
    except ImportError:
        logger.warning("gTTS not installed, skipping online TTS fallback")
    except Exception as e:
        logger.warning("gTTS speak failed: %s", e)

    logger.error("All TTS engines failed for: '%s...'", text[:50])
    return "error"


def speak_async(text: str) -> threading.Thread:
    """Speak text in a background thread (non-blocking)."""
    t = threading.Thread(target=speak, args=(text,), daemon=True)
    t.start()
    return t


# ─── STT Engine ──────────────────────────────────────────────────────────

def listen(timeout: int = 5, phrase_limit: int = 10) -> dict:
    """
    Listen to the microphone and convert speech to text.

    Uses Google Web Speech API (free, online).

    Parameters
    ----------
    timeout : int
        Max seconds to wait for speech to start.
    phrase_limit : int
        Max seconds of speech to capture.

    Returns
    -------
    dict
        {"text": str, "status": "ok"|"error"|"empty", "engine": str}
    """
    try:
        import speech_recognition as sr
    except ImportError:
        logger.error("SpeechRecognition not installed")
        return {"text": "", "status": "error", "engine": "none",
                "error": "SpeechRecognition not installed"}

    recognizer = sr.Recognizer()

    try:
        with sr.Microphone() as source:
            logger.info("Adjusting for ambient noise...")
            recognizer.adjust_for_ambient_noise(source, duration=0.5)

            logger.info("Listening... (timeout=%ds, limit=%ds)", timeout, phrase_limit)
            audio = recognizer.listen(
                source,
                timeout=timeout,
                phrase_time_limit=phrase_limit,
            )

        # Try Google Web Speech API (free, no key needed)
        text = recognizer.recognize_google(audio)
        logger.info("Heard: '%s'", text)
        return {"text": text, "status": "ok", "engine": "google"}

    except sr.WaitTimeoutError:
        logger.info("No speech detected within timeout")
        return {"text": "", "status": "empty", "engine": "google",
                "error": "No speech detected"}

    except sr.UnknownValueError:
        logger.info("Could not understand audio")
        return {"text": "", "status": "empty", "engine": "google",
                "error": "Could not understand audio"}

    except sr.RequestError as e:
        logger.error("Google STT API error: %s", e)
        return {"text": "", "status": "error", "engine": "google",
                "error": str(e)}

    except OSError as e:
        logger.error("Microphone error: %s", e)
        return {"text": "", "status": "error", "engine": "none",
                "error": f"Microphone error: {e}"}

    except Exception as e:
        logger.error("STT error: %s", e)
        return {"text": "", "status": "error", "engine": "none",
                "error": str(e)}


def listen_whisper(timeout: int = 5, phrase_limit: int = 10) -> dict:
    """
    Listen and transcribe using OpenAI Whisper API.

    Requires a valid OPENAI_API_KEY in config.

    Parameters
    ----------
    timeout : int
        Max seconds to wait for speech to start.
    phrase_limit : int
        Max seconds of speech to capture.

    Returns
    -------
    dict
        {"text": str, "status": "ok"|"error"|"empty", "engine": str}
    """
    try:
        import speech_recognition as sr
    except ImportError:
        return {"text": "", "status": "error", "engine": "none",
                "error": "SpeechRecognition not installed"}

    recognizer = sr.Recognizer()

    try:
        with sr.Microphone() as source:
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            audio = recognizer.listen(
                source,
                timeout=timeout,
                phrase_time_limit=phrase_limit,
            )

        # Use OpenAI Whisper API
        text = recognizer.recognize_whisper_api(
            audio,
            api_key=config.OPENAI_API_KEY,
        )
        logger.info("Heard (Whisper): '%s'", text)
        return {"text": text, "status": "ok", "engine": "whisper"}

    except sr.WaitTimeoutError:
        return {"text": "", "status": "empty", "engine": "whisper",
                "error": "No speech detected"}
    except sr.UnknownValueError:
        return {"text": "", "status": "empty", "engine": "whisper",
                "error": "Could not understand audio"}
    except Exception as e:
        logger.error("Whisper STT error: %s", e)
        return {"text": "", "status": "error", "engine": "whisper",
                "error": str(e)}


# ─── Audio Playback Helper ──────────────────────────────────────────────

def _play_audio(filepath: str) -> None:
    """Play an audio file using available system player."""
    import subprocess
    players = ["mpg123", "mpg321", "ffplay", "aplay"]
    for player in players:
        try:
            subprocess.run(
                [player, "-q", filepath] if player != "ffplay"
                else [player, "-nodisp", "-autoexit", "-loglevel", "quiet", filepath],
                check=True,
                timeout=30,
            )
            return
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    logger.warning("No audio player found to play %s", filepath)


# ─── Voice Conversation Loop ────────────────────────────────────────────

def voice_loop():
    """
    Interactive voice conversation loop.
    Listens → processes goal → speaks result.
    Press Ctrl+C to exit.
    """
    from controller import run_goal

    print("\n" + "=" * 50)
    print("  JARVIS - Voice Mode")
    print("  Say your goal. Say 'exit' or 'quit' to stop.")
    print("=" * 50 + "\n")

    speak("Jarvis voice mode activated. How can I help you?")

    while True:
        try:
            result = listen(timeout=10, phrase_limit=15)

            if result["status"] == "error":
                speak("Sorry, I couldn't access the microphone.")
                print(f"  [Error] {result.get('error', 'unknown')}")
                continue

            if result["status"] == "empty":
                continue

            text = result["text"]
            print(f"  You: {text}")

            # Check for exit commands
            if any(word in text.lower() for word in ["exit", "quit", "stop", "goodbye"]):
                speak("Goodbye!")
                break

            # Execute the goal
            goal_result = run_goal(text)
            status = goal_result.get("status", "unknown")

            if status == "blocked":
                response = f"I blocked that command for safety: {goal_result.get('reason', 'unsafe')}"
            elif status == "error":
                response = f"I encountered an error: {goal_result.get('error', 'unknown')}"
            else:
                response = f"Done. Result: {goal_result.get('result', 'completed')}"

            print(f"  Jarvis: {response}")
            speak(response)

        except KeyboardInterrupt:
            speak("Goodbye!")
            print("\n  Voice mode ended.")
            break
