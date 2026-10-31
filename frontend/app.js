import {
  deleteVocabularyEntry,
  listVocabularyEntries,
  requestPhrasePart,
  requestQuickLookup,
  requestSentenceGrammar,
  requestSentenceTranslation,
  saveVocabularyEntry,
} from "./api_client.js";
import {
  MAXIMUM_WORDS_FOR_PHRASE_ANALYSIS,
  countWords,
  expandRangeToWordBoundaries,
  extractContextSentence,
  extractPlainTextFromRange,
  normalizeWhitespace,
  trimSurroundingPunctuation,
} from "./selection_context.js";
import { refreshSavedWordHighlights, setSavedVocabulary } from "./saved_word_highlighter.js";
import { findCoreResult, renderSidePanel } from "./side_panel.js";

const ANALYSIS_PART_NAMES = ["core", "usage", "synonyms"];

const PDFJS_VERSION = "4.10.38";
const PDFJS_BASE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const MINIMUM_ZOOM_SCALE = 0.4;
const MAXIMUM_ZOOM_SCALE = 4;
const ZOOM_STEP_FACTOR = 1.1;
const ADAPTIVE_SCALE_VALUES = new Set(["auto", "page-width", "page-fit", "page-actual"]);

const pageElements = {
  viewerContainer: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  sidePanel: document.getElementById("sidePanel"),
  documentTitle: document.getElementById("documentTitle"),
  pageNumberInput: document.getElementById("pageNumberInput"),
  pageCountLabel: document.getElementById("pageCountLabel"),
  zoomLabel: document.getElementById("zoomLabel"),
  openDocumentButton: document.getElementById("openDocumentButton"),
  documentFileInput: document.getElementById("documentFileInput"),
  zoomInButton: document.getElementById("zoomInButton"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  toggleSidePanelButton: document.getElementById("toggleSidePanelButton"),
  openVocabularyButton: document.getElementById("openVocabularyButton"),
};

const readerState = {
  pdfjsLib: null,
  pdfViewer: null,
  linkService: null,
  currentPdfDocument: null,
  documentStorageKey: null,
  documentDisplayName: null,
  panelState: null,
  analysisLanguage: readStoredValue("analysisLanguage") || "en",
  activePhraseLookupAbortController: null,
  lastSelectionSignature: null,
};

function readStoredValue(storageKey) {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeStoredValue(storageKey, storedValue) {
  try {
    localStorage.setItem(storageKey, storedValue);
  } catch {
    // Storage can be unavailable; the reader then simply does not remember preferences.
  }
}

function isAbortError(error) {
  return error && error.name === "AbortError";
}

function findClosestElement(node, cssSelector) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element ? element.closest(cssSelector) : null;
}

function extractFileName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

// ---------- PDF viewer ----------

async function loadPdfJsLibraries() {
  const pdfjsLib = await import(`${PDFJS_BASE_URL}/build/pdf.min.mjs`);
  // The viewer component reads the core library from this global instead of importing it.
  globalThis.pdfjsLib = pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE_URL}/build/pdf.worker.min.mjs`;
  const pdfjsViewer = await import(`${PDFJS_BASE_URL}/web/pdf_viewer.mjs`);
  return { pdfjsLib, pdfjsViewer };
}

function initializeViewer(pdfjsViewer) {
  const eventBus = new pdfjsViewer.EventBus();
  const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
  const pdfViewer = new pdfjsViewer.PDFViewer({
    container: pageElements.viewerContainer,
    viewer: pageElements.viewer,
    eventBus,
    linkService,
  });
  linkService.setViewer(pdfViewer);
  readerState.pdfViewer = pdfViewer;
  readerState.linkService = linkService;

  eventBus.on("pagesinit", restoreReadingPosition);
  eventBus.on("textlayerrendered", scheduleHighlightRefresh);
  eventBus.on("pagechanging", (pageChangeEvent) => {
    pageElements.pageNumberInput.value = pageChangeEvent.pageNumber;
    if (readerState.documentStorageKey) {
      writeStoredValue(`lastPage:${readerState.documentStorageKey}`, String(pageChangeEvent.pageNumber));
    }
  });
  eventBus.on("scalechanging", (scaleChangeEvent) => {
    // The text layer is rebuilt at the new scale; an old selection would stay drawn at its
    // previous position, detached from the text.
    window.getSelection()?.removeAllRanges();
    readerState.lastSelectionSignature = null;
    pageElements.zoomLabel.textContent = `${Math.round(scaleChangeEvent.scale * 100)}%`;
    writeStoredValue("zoomScale", scaleChangeEvent.presetValue || String(scaleChangeEvent.scale));
  });
}

function restoreReadingPosition() {
  const pdfViewer = readerState.pdfViewer;
  pdfViewer.currentScaleValue = readStoredValue("zoomScale") || "auto";
  const storedPageNumber = Number(readStoredValue(`lastPage:${readerState.documentStorageKey}`));
  if (storedPageNumber >= 1 && storedPageNumber <= pdfViewer.pagesCount) {
    pdfViewer.currentPageNumber = storedPageNumber;
  }
}

async function openDocument(documentSource, displayName, storageKey) {
  if (!readerState.pdfjsLib) {
    return;
  }
  const loadingTask = readerState.pdfjsLib.getDocument({
    ...documentSource,
    cMapUrl: `${PDFJS_BASE_URL}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE_URL}/standard_fonts/`,
  });

  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
  } catch (loadError) {
    pageElements.documentTitle.textContent = `Не удалось открыть «${displayName}»: ${loadError.message}`;
    return;
  }

  const previousPdfDocument = readerState.currentPdfDocument;
  readerState.currentPdfDocument = pdfDocument;
  readerState.documentStorageKey = storageKey;
  readerState.documentDisplayName = displayName;

  readerState.pdfViewer.setDocument(pdfDocument);
  readerState.linkService.setDocument(pdfDocument, null);
  if (previousPdfDocument) {
    await previousPdfDocument.destroy();
  }

  pageElements.documentTitle.textContent = displayName;
  document.title = `${displayName} — PDF Word Reader`;
  pageElements.pageCountLabel.textContent = `/ ${pdfDocument.numPages}`;
  pageElements.pageNumberInput.max = String(pdfDocument.numPages);
  document.body.classList.add("document-loaded");
}

async function openLocalFile(pdfFile) {
  const fileBytes = new Uint8Array(await pdfFile.arrayBuffer());
  await openDocument({ data: fileBytes }, pdfFile.name, `${pdfFile.name}:${pdfFile.size}`);
}

function refitAdaptiveScale() {
  const pdfViewer = readerState.pdfViewer;
  // Preset scales such as "auto" are computed from the container width once, so they
  // must be re-applied after the available width changes.
  if (pdfViewer && readerState.currentPdfDocument && ADAPTIVE_SCALE_VALUES.has(pdfViewer.currentScaleValue)) {
    pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
  }
}

function computeZoomOrigin(clientX, clientY) {
  // PDF.js subtracts the container's offsetLeft/offsetTop from the origin, which are measured
  // against #readerLayout, while client coordinates include the toolbar above it.
  const containerElement = pageElements.viewerContainer;
  const containerRect = containerElement.getBoundingClientRect();
  return [
    clientX - containerRect.left + containerElement.offsetLeft,
    clientY - containerRect.top + containerElement.offsetTop,
  ];
}

function changeZoom(zoomFactor, clientX, clientY) {
  const pdfViewer = readerState.pdfViewer;
  if (!pdfViewer || !readerState.currentPdfDocument) {
    return;
  }
  const containerRect = pageElements.viewerContainer.getBoundingClientRect();
  // Buttons zoom around the centre of the view and the wheel around the cursor, so the line
  // being read stays where it was instead of jumping to the page top.
  const anchorClientX = clientX ?? containerRect.left + containerRect.width / 2;
  const anchorClientY = clientY ?? containerRect.top + containerRect.height / 2;
  const currentScale = pdfViewer.currentScale;
  const boundedScaleFactor =
    Math.min(MAXIMUM_ZOOM_SCALE, Math.max(MINIMUM_ZOOM_SCALE, currentScale * zoomFactor)) / currentScale;
  if (typeof pdfViewer.updateScale === "function") {
    pdfViewer.updateScale({
      scaleFactor: boundedScaleFactor,
      origin: computeZoomOrigin(anchorClientX, anchorClientY),
    });
  } else {
    pdfViewer.currentScale = currentScale * boundedScaleFactor;
  }
}

// ---------- saved word highlights ----------

let highlightRefreshIsScheduled = false;

function scheduleHighlightRefresh() {
  // Several pages finish rendering in a burst; one refresh per frame is enough.
  if (highlightRefreshIsScheduled) {
    return;
  }
  highlightRefreshIsScheduled = true;
  requestAnimationFrame(() => {
    highlightRefreshIsScheduled = false;
    refreshSavedWordHighlights(pageElements.viewer);
  });
}

async function reloadSavedWordHighlights() {
  try {
    setSavedVocabulary(await listVocabularyEntries());
  } catch {
    // Highlighting is a convenience; reading must keep working if the list cannot load.
    return;
  }
  scheduleHighlightRefresh();
}

// ---------- side panel ----------

const panelRenderOptions = {
  get analysisLanguage() {
    return readerState.analysisLanguage;
  },
  onLanguageChange(languageCode) {
    readerState.analysisLanguage = languageCode;
    writeStoredValue("analysisLanguage", languageCode);
    const currentPanelState = readerState.panelState;
    // The other language is generated only on demand, so switching is the moment to fetch it.
    if (currentPanelState?.mode === "phrase") {
      loadAnalysisLanguage(currentPanelState, languageCode);
    }
    if (currentPanelState?.mode === "sentence" && currentPanelState.isGrammarRequested) {
      loadSentenceGrammar(currentPanelState, languageCode);
    }
    rerenderSidePanel();
  },
  onExplainGrammar() {
    const currentPanelState = readerState.panelState;
    if (currentPanelState?.mode === "sentence") {
      currentPanelState.isGrammarRequested = true;
      loadSentenceGrammar(currentPanelState, readerState.analysisLanguage, { forceReload: true });
      rerenderSidePanel();
    }
  },
  onBack() {
    const parentPanelState = readerState.panelState?.parentPanelState;
    if (!parentPanelState) {
      return;
    }
    readerState.activePhraseLookupAbortController?.abort();
    if (parentPanelState.mode === "phrase") {
      resumePhraseLookup(parentPanelState);
    }
    showPanelState(parentPanelState);
  },
  onRetryPart(partName) {
    const currentPanelState = readerState.panelState;
    if (currentPanelState?.mode === "phrase") {
      loadAnalysisPart(currentPanelState, readerState.analysisLanguage, partName);
      rerenderSidePanel();
    }
  },
  onSave() {
    saveCurrentPhrase();
  },
  onOpenVocabulary() {
    openVocabularyView();
  },
  onOpenVocabularyEntry(vocabularyEntry) {
    // Lookups hit the server cache, so reopening a saved word does not call Claude again.
    startPhraseLookup(vocabularyEntry.phrase, vocabularyEntry.context_sentence, null, { openedFromVocabulary: true });
  },
  onDeleteVocabularyEntry(vocabularyEntry) {
    removeVocabularyEntry(vocabularyEntry);
  },
};

function rerenderSidePanel() {
  renderSidePanel(pageElements.sidePanel, readerState.panelState, panelRenderOptions);
}

function rerenderIfCurrent(panelState) {
  if (panelState === readerState.panelState) {
    rerenderSidePanel();
  }
}

function showPanelState(panelState) {
  readerState.panelState = panelState;
  if (!document.body.classList.contains("side-panel-visible")) {
    document.body.classList.add("side-panel-visible");
    refitAdaptiveScale();
  }
  rerenderSidePanel();
  pageElements.sidePanel.scrollTop = 0;
}

function collectAnalysisResults(phraseState) {
  // Saved shape: {language: {part_name: result}}, only for parts that actually finished.
  const analysisByLanguage = {};
  for (const [language, partsOfLanguage] of Object.entries(phraseState.partsByLanguage)) {
    for (const [partName, partState] of Object.entries(partsOfLanguage)) {
      if (partState.result) {
        analysisByLanguage[language] = analysisByLanguage[language] || {};
        analysisByLanguage[language][partName] = partState.result;
      }
    }
  }
  return analysisByLanguage;
}

function buildVocabularyPayload(phraseState) {
  return {
    phrase: phraseState.phrase,
    context_sentence: phraseState.contextSentence,
    translation_ru:
      phraseState.quickLookup?.translation?.translated_text || findCoreResult(phraseState)?.translation_ru || "",
    analysis: collectAnalysisResults(phraseState),
    source_document_name: readerState.documentDisplayName,
  };
}

async function saveCurrentPhrase() {
  const phraseState = readerState.panelState;
  if (!phraseState || phraseState.mode !== "phrase") {
    return;
  }
  try {
    await saveVocabularyEntry(buildVocabularyPayload(phraseState));
    phraseState.isSaved = true;
    reloadSavedWordHighlights();
  } catch (saveError) {
    window.alert(`Не удалось сохранить: ${saveError.message}`);
  }
  rerenderIfCurrent(phraseState);
}

function loadAnalysisPart(phraseState, language, partName) {
  const partsOfLanguage = (phraseState.partsByLanguage[language] = phraseState.partsByLanguage[language] || {});
  const partState = { isLoading: true, result: null, error: null };
  partsOfLanguage[partName] = partState;

  requestPhrasePart(phraseState.phrase, phraseState.contextSentence, language, partName, phraseState.abortSignal)
    .then((partResponse) => {
      partState.result = partResponse.result;
      // A word saved before Claude finished is re-saved so the flashcard gets the full analysis.
      if (phraseState.isSaved) {
        saveVocabularyEntry(buildVocabularyPayload(phraseState)).catch(() => {});
      }
    })
    .catch((partError) => {
      partState.error = isAbortError(partError) ? "запрос отменён" : partError.message;
    })
    .finally(() => {
      partState.isLoading = false;
      rerenderIfCurrent(phraseState);
    });
}

function loadAnalysisLanguage(phraseState, language) {
  for (const partName of ANALYSIS_PART_NAMES) {
    const existingPartState = phraseState.partsByLanguage[language]?.[partName];
    const needsLoading = !existingPartState || (!existingPartState.isLoading && !existingPartState.result);
    if (needsLoading) {
      loadAnalysisPart(phraseState, language, partName);
    }
  }
}

function resumePhraseLookup(phraseState) {
  // Requests of a phrase view were aborted when the user drilled into another word. The
  // server kept those Claude calls running and cached them, so re-requesting is instant.
  const lookupAbortController = new AbortController();
  readerState.activePhraseLookupAbortController = lookupAbortController;
  phraseState.abortSignal = lookupAbortController.signal;
  for (const [language, partsOfLanguage] of Object.entries(phraseState.partsByLanguage)) {
    for (const [partName, partState] of Object.entries(partsOfLanguage)) {
      if (!partState.result) {
        loadAnalysisPart(phraseState, language, partName);
      }
    }
  }
}

function startPhraseLookup(phrase, contextSentence, parentPanelState, lookupOptions = {}) {
  // Only one phrase lookup is active: pending Claude requests would otherwise occupy the
  // browser's small per-host connection pool and delay the next lookup.
  readerState.activePhraseLookupAbortController?.abort();
  const lookupAbortController = new AbortController();
  readerState.activePhraseLookupAbortController = lookupAbortController;

  const phraseState = {
    mode: "phrase",
    phrase,
    contextSentence,
    parentPanelState,
    openedFromVocabulary: Boolean(lookupOptions.openedFromVocabulary),
    abortSignal: lookupAbortController.signal,
    quickLookup: null,
    quickLookupError: null,
    isQuickLookupLoading: true,
    partsByLanguage: {},
    isSaved: Boolean(lookupOptions.openedFromVocabulary),
  };
  showPanelState(phraseState);

  requestQuickLookup(phrase, lookupAbortController.signal)
    .then((quickLookupResponse) => {
      phraseState.quickLookup = quickLookupResponse;
    })
    .catch((quickLookupError) => {
      if (!isAbortError(quickLookupError)) {
        phraseState.quickLookupError = quickLookupError.message;
      }
    })
    .finally(() => {
      phraseState.isQuickLookupLoading = false;
      rerenderIfCurrent(phraseState);
    });

  loadAnalysisLanguage(phraseState, readerState.analysisLanguage);
}

async function openVocabularyView() {
  readerState.activePhraseLookupAbortController?.abort();
  const vocabularyState = { mode: "vocabulary", isLoading: true, entries: [], error: null };
  showPanelState(vocabularyState);
  try {
    vocabularyState.entries = await listVocabularyEntries();
  } catch (loadError) {
    vocabularyState.error = `Не удалось загрузить словарь: ${loadError.message}`;
  }
  vocabularyState.isLoading = false;
  rerenderIfCurrent(vocabularyState);
}

async function removeVocabularyEntry(vocabularyEntry) {
  const vocabularyState = readerState.panelState;
  try {
    await deleteVocabularyEntry(vocabularyEntry.vocabulary_entry_id);
    vocabularyState.entries = vocabularyState.entries.filter(
      (existingEntry) => existingEntry.vocabulary_entry_id !== vocabularyEntry.vocabulary_entry_id,
    );
    setSavedVocabulary(vocabularyState.entries);
    scheduleHighlightRefresh();
  } catch (deleteError) {
    vocabularyState.error = `Не удалось удалить: ${deleteError.message}`;
  }
  rerenderIfCurrent(vocabularyState);
}

function loadSentenceGrammar(sentenceState, language, loadOptions = {}) {
  const existingGrammarState = sentenceState.grammarByLanguage[language];
  const isAlreadyAvailable = existingGrammarState && (existingGrammarState.isLoading || existingGrammarState.result);
  if (isAlreadyAvailable && !loadOptions.forceReload) {
    return;
  }
  if (existingGrammarState?.isLoading) {
    return;
  }
  const grammarState = { isLoading: true, result: null, error: null };
  sentenceState.grammarByLanguage[language] = grammarState;
  requestSentenceGrammar(sentenceState.sourceText, language)
    .then((grammarResponse) => {
      grammarState.result = grammarResponse.result;
    })
    .catch((grammarError) => {
      grammarState.error = grammarError.message;
    })
    .finally(() => {
      grammarState.isLoading = false;
      rerenderIfCurrent(sentenceState);
    });
}

function startSentenceTranslation(sourceText, parentPanelState = null) {
  // Sentence translations are not aborted: they are fast, and the sentence view may later
  // become the "back" target of a word lookup, so it must always finish.
  const sentenceState = {
    mode: "sentence",
    sourceText,
    parentPanelState,
    translatedText: "",
    translationError: null,
    isLoading: true,
    // Grammar is generated only on request: it costs a Claude call, and most sentences only
    // need the translation.
    isGrammarRequested: false,
    grammarByLanguage: {},
  };
  showPanelState(sentenceState);

  requestSentenceTranslation(sourceText)
    .then((translationResponse) => {
      sentenceState.translatedText = translationResponse.translated_text;
    })
    .catch((translationError) => {
      sentenceState.translationError = translationError.message;
    })
    .finally(() => {
      sentenceState.isLoading = false;
      rerenderIfCurrent(sentenceState);
    });
}

// ---------- selection handling ----------

function computePdfContextSentence(selectionRange, selectedText) {
  const startTextLayer = findClosestElement(selectionRange.startContainer, ".textLayer");
  const endTextLayer = findClosestElement(selectionRange.endContainer, ".textLayer");
  if (!startTextLayer || startTextLayer !== endTextLayer) {
    return selectedText;
  }
  return extractContextSentence(selectionRange, startTextLayer);
}

function processCurrentSelection() {
  const currentSelection = window.getSelection();
  if (!currentSelection || currentSelection.isCollapsed || currentSelection.rangeCount === 0) {
    readerState.lastSelectionSignature = null;
    return;
  }
  const selectionRange = expandRangeToWordBoundaries(currentSelection.getRangeAt(0));
  const isPdfSelection = pageElements.viewer.contains(selectionRange.commonAncestorContainer);
  // Any English text in the panel is a source too (explanations, synonyms, examples), so an
  // unknown word inside an explanation can be looked up the same way as in the book.
  const isPanelSelection = pageElements.sidePanel.contains(selectionRange.commonAncestorContainer);
  if (!isPdfSelection && !isPanelSelection) {
    return;
  }

  const selectedText = normalizeWhitespace(extractPlainTextFromRange(selectionRange));
  if (!selectedText || !/[A-Za-z]/.test(selectedText)) {
    return;
  }
  // mouseup also fires for clicks that leave an existing selection untouched; without
  // this check every such click would restart the same lookup.
  const selectionSignature = `${isPdfSelection ? "pdf" : "panel"}|${selectedText}`;
  if (selectionSignature === readerState.lastSelectionSignature) {
    return;
  }
  readerState.lastSelectionSignature = selectionSignature;

  const isPhrase = countWords(selectedText) <= MAXIMUM_WORDS_FOR_PHRASE_ANALYSIS;
  if (isPdfSelection) {
    if (isPhrase) {
      const phrase = trimSurroundingPunctuation(selectedText);
      if (phrase) {
        startPhraseLookup(phrase, computePdfContextSentence(selectionRange, selectedText), null);
      }
    } else {
      startSentenceTranslation(selectedText);
    }
    return;
  }

  // Inside the panel the surrounding block (sentence, example, explanation line) is the
  // context, and the current view becomes the target of the "back" button.
  const currentPanelState = readerState.panelState;
  const parentPanelState = currentPanelState?.mode === "vocabulary" ? null : currentPanelState;
  if (isPhrase) {
    const phrase = trimSurroundingPunctuation(selectedText);
    if (!phrase) {
      return;
    }
    const contextBlockElement =
      findClosestElement(selectionRange.commonAncestorContainer, ".selectable-source, li, p") ||
      findClosestElement(selectionRange.commonAncestorContainer, "div");
    const contextText = contextBlockElement ? normalizeWhitespace(contextBlockElement.textContent) : selectedText;
    startPhraseLookup(phrase, contextText, parentPanelState);
  } else {
    startSentenceTranslation(selectedText, parentPanelState);
  }
}

// ---------- wiring ----------

function wireSelectionHandling() {
  document.addEventListener("mouseup", (mouseEvent) => {
    if (mouseEvent.button !== 0) {
      return;
    }
    if (mouseEvent.target instanceof Element && mouseEvent.target.closest("button, a, input, summary")) {
      return;
    }
    // A double-click word selection is finalized after mouseup, so it is read on the next tick.
    setTimeout(processCurrentSelection, 0);
  });
}

function wireToolbar() {
  pageElements.openDocumentButton.addEventListener("click", () => pageElements.documentFileInput.click());
  pageElements.documentFileInput.addEventListener("change", () => {
    const selectedFile = pageElements.documentFileInput.files[0];
    if (selectedFile) {
      openLocalFile(selectedFile);
    }
    pageElements.documentFileInput.value = "";
  });

  pageElements.pageNumberInput.addEventListener("change", () => {
    const requestedPageNumber = Number(pageElements.pageNumberInput.value);
    const pdfViewer = readerState.pdfViewer;
    if (pdfViewer && requestedPageNumber >= 1 && requestedPageNumber <= pdfViewer.pagesCount) {
      pdfViewer.currentPageNumber = requestedPageNumber;
    }
  });

  pageElements.openVocabularyButton.addEventListener("click", openVocabularyView);
  pageElements.zoomInButton.addEventListener("click", () => changeZoom(ZOOM_STEP_FACTOR));
  pageElements.zoomOutButton.addEventListener("click", () => changeZoom(1 / ZOOM_STEP_FACTOR));
  pageElements.viewerContainer.addEventListener(
    "wheel",
    (wheelEvent) => {
      // Ctrl+wheel zooms the PDF only; the browser's own zoom would also scale the toolbar and panel.
      if (wheelEvent.ctrlKey) {
        wheelEvent.preventDefault();
        changeZoom(wheelEvent.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR, wheelEvent.clientX, wheelEvent.clientY);
      }
    },
    { passive: false },
  );

  pageElements.toggleSidePanelButton.addEventListener("click", () => {
    document.body.classList.toggle("side-panel-visible");
    refitAdaptiveScale();
  });
  window.addEventListener("resize", refitAdaptiveScale);
}

const MINIMUM_SIDE_PANEL_WIDTH = 220;
const MINIMUM_BOOK_AREA_WIDTH = 240;

function applySidePanelWidth(requestedPanelWidth) {
  // The book always keeps a usable minimum width, otherwise a wide panel in a narrow
  // window would push the page out of view.
  const maximumPanelWidth = Math.max(MINIMUM_SIDE_PANEL_WIDTH, window.innerWidth - MINIMUM_BOOK_AREA_WIDTH);
  const clampedPanelWidth = Math.min(maximumPanelWidth, Math.max(MINIMUM_SIDE_PANEL_WIDTH, requestedPanelWidth));
  document.documentElement.style.setProperty("--side-panel-width", `${Math.round(clampedPanelWidth)}px`);
  return clampedPanelWidth;
}

function wirePanelResizing() {
  const resizeHandle = document.getElementById("panelResizeHandle");
  const storedPanelWidth = Number(readStoredValue("sidePanelWidth"));
  if (storedPanelWidth > 0) {
    applySidePanelWidth(storedPanelWidth);
  }

  resizeHandle.addEventListener("pointerdown", (pointerDownEvent) => {
    pointerDownEvent.preventDefault();
    resizeHandle.setPointerCapture(pointerDownEvent.pointerId);
    document.body.classList.add("panel-resizing");
  });
  resizeHandle.addEventListener("pointermove", (pointerMoveEvent) => {
    if (!document.body.classList.contains("panel-resizing")) {
      return;
    }
    applySidePanelWidth(window.innerWidth - pointerMoveEvent.clientX);
  });
  const finishResizing = () => {
    if (!document.body.classList.contains("panel-resizing")) {
      return;
    }
    document.body.classList.remove("panel-resizing");
    const currentPanelWidth = document.getElementById("sidePanel").getBoundingClientRect().width;
    writeStoredValue("sidePanelWidth", String(Math.round(currentPanelWidth)));
    refitAdaptiveScale();
  };
  resizeHandle.addEventListener("pointerup", finishResizing);
  resizeHandle.addEventListener("pointercancel", finishResizing);

  window.addEventListener("resize", () => {
    const savedPanelWidth = Number(readStoredValue("sidePanelWidth"));
    if (savedPanelWidth > 0) {
      applySidePanelWidth(savedPanelWidth);
    }
  });
}

function wireDragAndDrop() {
  window.addEventListener("dragover", (dragEvent) => {
    dragEvent.preventDefault();
    document.body.classList.add("drag-over");
  });
  window.addEventListener("dragleave", () => document.body.classList.remove("drag-over"));
  window.addEventListener("drop", (dropEvent) => {
    dropEvent.preventDefault();
    document.body.classList.remove("drag-over");
    const droppedFile = dropEvent.dataTransfer?.files?.[0];
    if (droppedFile && droppedFile.name.toLowerCase().endsWith(".pdf")) {
      openLocalFile(droppedFile);
    }
  });
}

async function startReader() {
  rerenderSidePanel();
  reloadSavedWordHighlights();
  wireSelectionHandling();
  wireToolbar();
  wirePanelResizing();
  wireDragAndDrop();

  try {
    const { pdfjsLib, pdfjsViewer } = await loadPdfJsLibraries();
    readerState.pdfjsLib = pdfjsLib;
    initializeViewer(pdfjsViewer);
  } catch (libraryLoadError) {
    pageElements.documentTitle.textContent = `PDF.js не загрузился (нужен интернет): ${libraryLoadError.message}`;
    return;
  }

  // The launcher passes the file chosen in Explorer's "Open with" through this parameter.
  const documentPathFromLauncher = new URLSearchParams(window.location.search).get("file");
  if (documentPathFromLauncher) {
    await openDocument(
      { url: `/api/document?path=${encodeURIComponent(documentPathFromLauncher)}` },
      extractFileName(documentPathFromLauncher),
      documentPathFromLauncher,
    );
  }
}

startReader();
