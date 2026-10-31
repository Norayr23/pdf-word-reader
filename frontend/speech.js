let preferredEnglishVoice = null;

function choosePreferredEnglishVoice() {
  const availableVoices = window.speechSynthesis.getVoices();
  const englishVoices = availableVoices.filter(
    (voice) => voice.lang && voice.lang.toLowerCase().startsWith("en"),
  );
  // Edge ships neural "Natural" voices that sound much closer to a human reader than the
  // legacy system voices, so they win whenever they are installed.
  preferredEnglishVoice =
    englishVoices.find((voice) => /natural/i.test(voice.name) && voice.lang === "en-US") ||
    englishVoices.find((voice) => /natural/i.test(voice.name)) ||
    // Chrome has no Microsoft Natural voices; its online Google voice is the closest in quality.
    englishVoices.find((voice) => voice.name === "Google US English") ||
    englishVoices.find((voice) => voice.lang === "en-US") ||
    englishVoices[0] ||
    null;
}

if ("speechSynthesis" in window) {
  choosePreferredEnglishVoice();
  // Voices load asynchronously; the list is usually empty on the first call.
  window.speechSynthesis.addEventListener("voiceschanged", choosePreferredEnglishVoice);
}

export function speakEnglishText(text, speechRate = 0.95) {
  if (!("speechSynthesis" in window) || !text) {
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (preferredEnglishVoice) {
    utterance.voice = preferredEnglishVoice;
    utterance.lang = preferredEnglishVoice.lang;
  } else {
    utterance.lang = "en-US";
  }
  utterance.rate = speechRate;
  window.speechSynthesis.speak(utterance);
}

export function playRecordedPronunciation(audioUrl, onPlaybackFailed) {
  const recordedAudio = new Audio(audioUrl);
  // A silent failure looked like a broken button; the caller shows the failure instead.
  recordedAudio.addEventListener("error", () => onPlaybackFailed?.());
  recordedAudio.play().catch(() => onPlaybackFailed?.());
}
