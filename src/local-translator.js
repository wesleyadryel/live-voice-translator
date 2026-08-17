// Chrome's on-device Translator API. Nothing here reaches the network or the API key:
// the language pack lives in the browser, so translating a transcript line costs no
// tokens and works with the meeting already over. It is used for reading, never for
// the voice — the interpreter stays with the realtime model.

const CODES = {
  English: "en",
  Spanish: "es",
  German: "de",
  French: "fr",
  Russian: "ru",
  "Brazilian Portuguese": "pt"
};

export const bcp47 = (language) => CODES[language] || String(language || "").slice(0, 2).toLowerCase();

export const localTranslationSupported = () => typeof Translator !== "undefined";

const pairKey = (source, target) => `${source}>${target}`;
// One translator per direction, kept for the life of the panel: creating one is the
// expensive part and a meeting uses the same two directions from start to finish.
const translators = new Map();

export async function localTranslationAvailability(from, to) {
  const source = bcp47(from);
  const target = bcp47(to);
  if (!localTranslationSupported() || !source || !target || source === target) return "unavailable";
  try {
    return await Translator.availability({ sourceLanguage: source, targetLanguage: target });
  } catch {
    return "unavailable";
  }
}

// A pack that still has to be downloaded may only be fetched from a user gesture, so
// this is called from a click. Once the pack is on disk the same call resolves without
// one, which is why hovering works from the second meeting onwards.
export function createLocalTranslator(from, to, onProgress) {
  const source = bcp47(from);
  const target = bcp47(to);
  if (!localTranslationSupported() || !source || !target || source === target) return Promise.resolve(null);
  const key = pairKey(source, target);
  if (!translators.has(key)) {
    const pending = Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor: (monitor) => {
        monitor.addEventListener("downloadprogress", (event) => onProgress?.(event.loaded ?? 0));
      }
    }).catch(() => {
      // A refusal is not permanent — the pack may simply need the gesture this call did
      // not have — so the failure is not what the next attempt inherits.
      translators.delete(key);
      return null;
    });
    translators.set(key, pending);
  }
  return translators.get(key);
}

export async function translateLocally(text, from, to) {
  if (!text) return "";
  const translator = await createLocalTranslator(from, to);
  if (!translator) return "";
  try {
    return (await translator.translate(text)) || "";
  } catch {
    return "";
  }
}
