import { playRecordedPronunciation, speakEnglishText } from "./speech.js";

const SLOW_SPEECH_RATE = 0.6;

const SECTION_TITLES = {
  en: {
    meaning: "Meaning in context",
    breakdown: "Word breakdown",
    usage: "Usage: literal & figurative",
    examples: "Examples",
    synonyms: "Synonyms",
  },
  ru: {
    meaning: "Значение в контексте",
    breakdown: "Разбор слова",
    usage: "Употребление: прямое и переносное",
    examples: "Примеры",
    synonyms: "Синонимы",
  },
};

// Model output is inserted only through textContent, never innerHTML, so an unexpected
// answer cannot inject markup into the page.
function buildElement(tagName, elementOptions = {}, childNodes = []) {
  const element = document.createElement(tagName);
  if (elementOptions.className) {
    element.className = elementOptions.className;
  }
  if (elementOptions.text !== undefined && elementOptions.text !== null) {
    element.textContent = String(elementOptions.text);
  }
  if (elementOptions.title) {
    element.title = elementOptions.title;
  }
  if (elementOptions.onClick) {
    element.addEventListener("click", elementOptions.onClick);
  }
  for (const [attributeName, attributeValue] of Object.entries(elementOptions.attributes || {})) {
    element.setAttribute(attributeName, attributeValue);
  }
  for (const childNode of childNodes) {
    if (childNode) {
      element.append(childNode);
    }
  }
  return element;
}

function buildButton(label, onClick, title, isDisabled = false) {
  const button = buildElement("button", {
    className: "panel-button",
    text: label,
    title,
    onClick,
    attributes: { type: "button" },
  });
  button.disabled = isDisabled;
  return button;
}

function buildSection(sectionTitle, childNodes) {
  return buildElement("div", { className: "panel-section" }, [
    buildElement("h3", { text: sectionTitle }),
    ...childNodes,
  ]);
}

function buildLoadingIndicator(message) {
  return buildElement("div", { className: "loading-indicator", text: message });
}

function pickLocalizedText(localizedValue, language) {
  if (!localizedValue) {
    return "";
  }
  if (typeof localizedValue === "string") {
    return localizedValue;
  }
  return localizedValue[language] || localizedValue.en || localizedValue.ru || "";
}

function buildLanguageToggle(activeLanguage, onLanguageChange) {
  const languageButtons = ["en", "ru"].map((languageCode) =>
    buildElement("button", {
      text: languageCode.toUpperCase(),
      className: languageCode === activeLanguage ? "active" : "",
      title: "Язык объяснения",
      attributes: { type: "button" },
      onClick: () => onLanguageChange(languageCode),
    }),
  );
  return buildElement("span", { className: "language-toggle" }, languageButtons);
}

function buildSpeechButtons(textToSpeak) {
  return [
    buildButton("🔊", () => speakEnglishText(textToSpeak), "Произнести"),
    buildButton("🐢", () => speakEnglishText(textToSpeak, SLOW_SPEECH_RATE), "Произнести медленно"),
  ];
}

export function findCoreResult(panelState) {
  for (const language of ["en", "ru"]) {
    const coreResult = panelState.partsByLanguage?.[language]?.core?.result;
    if (coreResult) {
      return coreResult;
    }
  }
  return null;
}

function buildQuickTranslationNodes(panelState) {
  const translation = panelState.quickLookup?.translation;
  if (panelState.isQuickLookupLoading) {
    return [buildLoadingIndicator("Перевод…")];
  }
  if (translation?.translated_text) {
    const alternativeLines = (translation.alternatives_by_part_of_speech || []).map((alternativeGroup) =>
      buildElement("p", { className: "alternatives" }, [
        buildElement("b", { text: `${alternativeGroup.part_of_speech}: ` }),
        document.createTextNode(alternativeGroup.translations.join(", ")),
      ]),
    );
    return [buildElement("p", { className: "quick-translation", text: translation.translated_text }), ...alternativeLines];
  }
  const coreResult = findCoreResult(panelState);
  if (coreResult?.translation_ru) {
    return [buildElement("p", { className: "quick-translation", text: coreResult.translation_ru })];
  }
  const errorText = panelState.quickLookupError || panelState.quickLookup?.translation_error;
  if (errorText) {
    return [buildElement("p", { className: "error-message", text: `Перевод недоступен: ${errorText}` })];
  }
  return [];
}

const PART_LOADING_MESSAGES = {
  core: "Claude объясняет значение…",
  usage: "Claude подбирает примеры…",
  synonyms: "Claude подбирает синонимы…",
};

function buildPartStatusNodes(partState, partName, renderOptions) {
  if (!partState || partState.isLoading) {
    return [buildLoadingIndicator(PART_LOADING_MESSAGES[partName])];
  }
  if (partState.error) {
    return [
      buildElement("p", { className: "error-message", text: `Не получено: ${partState.error}` }),
      buildButton("Повторить", () => renderOptions.onRetryPart(partName)),
    ];
  }
  return null;
}

function buildCorePartNodes(coreResult, sectionTitles) {
  const coreNodes = [];
  if (coreResult.meaning_in_context) {
    coreNodes.push(buildSection(sectionTitles.meaning, [buildElement("p", { text: coreResult.meaning_in_context })]));
  }
  if (coreResult.word_breakdown) {
    coreNodes.push(buildSection(sectionTitles.breakdown, [buildElement("p", { text: coreResult.word_breakdown })]));
  }
  return coreNodes;
}

function buildUsagePartNodes(usageResult, sectionTitles) {
  const usageNodes = [];
  if (usageResult.usage_notes) {
    usageNodes.push(buildSection(sectionTitles.usage, [buildElement("p", { text: usageResult.usage_notes })]));
  }
  const examples = Array.isArray(usageResult.examples) ? usageResult.examples : [];
  if (examples.length > 0) {
    const exampleItems = examples.map((example) => {
      const englishExample = pickLocalizedText(example, "en");
      return buildElement("li", {}, [
        // Examples are selectable sources too: an unknown word inside an example can be
        // analysed with the example itself as context.
        buildElement("span", { className: "selectable-source", text: englishExample }),
        document.createTextNode(" "),
        buildButton("🔊", () => speakEnglishText(englishExample), "Произнести пример"),
        example.ru ? buildElement("div", { className: "example-translation", text: example.ru }) : null,
      ]);
    });
    usageNodes.push(buildSection(sectionTitles.examples, [buildElement("ul", { className: "examples-list" }, exampleItems)]));
  }
  return usageNodes;
}

function buildSynonymsPartNodes(synonymsResult, sectionTitles) {
  const synonyms = Array.isArray(synonymsResult.synonyms) ? synonymsResult.synonyms : [];
  if (synonyms.length === 0) {
    return [];
  }
  const synonymItems = synonyms.map((synonym) =>
    buildElement("li", {}, [
      buildElement("b", { text: synonym.word }),
      synonym.nuance ? document.createTextNode(` — ${synonym.nuance}`) : null,
    ]),
  );
  return [buildSection(sectionTitles.synonyms, [buildElement("ul", { className: "synonyms-list" }, synonymItems)])];
}

const PART_NODE_BUILDERS = {
  core: buildCorePartNodes,
  usage: buildUsagePartNodes,
  synonyms: buildSynonymsPartNodes,
};

function buildAnalysisNodes(panelState, renderOptions) {
  const language = renderOptions.analysisLanguage;
  const sectionTitles = SECTION_TITLES[language];
  const partsOfLanguage = panelState.partsByLanguage[language] || {};
  const analysisNodes = [];
  // Parts are rendered in a fixed order, each one as soon as its own request finishes.
  for (const partName of ["core", "usage", "synonyms"]) {
    const partState = partsOfLanguage[partName];
    const statusNodes = buildPartStatusNodes(partState, partName, renderOptions);
    if (statusNodes) {
      analysisNodes.push(...statusNodes);
    } else {
      analysisNodes.push(...PART_NODE_BUILDERS[partName](partState.result || {}, sectionTitles));
    }
  }
  return analysisNodes;
}

function buildDictionaryNodes(dictionary) {
  if (!dictionary || !Array.isArray(dictionary.meanings) || dictionary.meanings.length === 0) {
    return [];
  }
  const meaningBlocks = dictionary.meanings.map((meaning) =>
    buildElement("div", {}, [
      buildElement("p", {}, [buildElement("b", { text: meaning.part_of_speech })]),
      buildElement(
        "ol",
        { className: "definitions-list" },
        meaning.definitions.map((definition) =>
          buildElement("li", {}, [
            document.createTextNode(definition.definition),
            definition.example
              ? buildElement("div", { className: "example-translation", text: `“${definition.example}”` })
              : null,
          ]),
        ),
      ),
    ]),
  );
  const synonymsLine = dictionary.synonyms?.length
    ? buildElement("p", { className: "alternatives", text: `Synonyms: ${dictionary.synonyms.join(", ")}` })
    : null;
  return [
    buildElement("details", { className: "panel-section dictionary-details" }, [
      buildElement("summary", { text: "Словарное определение (Free Dictionary)" }),
      ...meaningBlocks,
      synonymsLine,
    ]),
  ];
}

function describeParentView(parentPanelState) {
  if (parentPanelState.mode === "phrase") {
    return parentPanelState.phrase;
  }
  return "К предложению";
}

function renderPhraseView(panelElement, panelState, renderOptions) {
  const dictionary = panelState.quickLookup?.dictionary || null;
  const coreResult = findCoreResult(panelState);
  const ipaTranscription = dictionary?.ipa || coreResult?.ipa || "";
  const partOfSpeech = coreResult?.part_of_speech || "";

  const topBar = buildElement("div", { className: "panel-top-bar" }, [
    panelState.parentPanelState ? buildButton(`← ${describeParentView(panelState.parentPanelState)}`, renderOptions.onBack) : null,
    panelState.openedFromVocabulary ? buildButton("← К словарю", renderOptions.onOpenVocabulary) : null,
    buildElement("span", { className: "spacer" }),
    buildLanguageToggle(renderOptions.analysisLanguage, renderOptions.onLanguageChange),
  ]);

  const metaLine = buildElement("p", { className: "phrase-meta" }, [
    ipaTranscription ? buildElement("span", { className: "ipa", text: ipaTranscription }) : null,
    partOfSpeech ? buildElement("span", { text: partOfSpeech }) : null,
  ]);

  const actionButtons = buildElement("div", { className: "phrase-actions" }, [
    ...buildSpeechButtons(panelState.phrase),
    dictionary?.audio_url
      ? buildButton("🎧 Запись", () => playRecordedPronunciation(dictionary.audio_url), "Запись носителя из словаря")
      : null,
    buildButton(
      panelState.isSaved ? "★ Сохранено" : "☆ В словарь",
      renderOptions.onSave,
      "Сохранить слово с контекстом",
      panelState.isSaved,
    ),
  ]);

  const contextNodes = panelState.contextSentence
    ? [
      buildSection("Контекст", [
        buildElement("p", { className: "context-sentence selectable-source", text: panelState.contextSentence }),
      ]),
    ]
    : [];

  panelElement.append(
    topBar,
    buildElement("h2", { className: "phrase-heading", text: panelState.phrase }),
    metaLine,
    actionButtons,
    ...buildQuickTranslationNodes(panelState),
    ...buildAnalysisNodes(panelState, renderOptions),
    ...buildDictionaryNodes(dictionary),
    ...contextNodes,
  );
}

const GRAMMAR_TITLES = {
  en: { section: "Grammar", structure: "Structure", simplified: "In simpler words", button: "📐 Explain grammar" },
  ru: { section: "Грамматика", structure: "Строение", simplified: "Проще", button: "📐 Разобрать грамматику" },
};

function buildGrammarNodes(panelState, renderOptions) {
  const language = renderOptions.analysisLanguage;
  const grammarTitles = GRAMMAR_TITLES[language];
  const grammarState = panelState.grammarByLanguage[language];
  if (!panelState.isGrammarRequested) {
    return [buildButton(grammarTitles.button, renderOptions.onExplainGrammar, "Claude разберёт строение предложения")];
  }
  if (!grammarState || grammarState.isLoading) {
    return [buildSection(grammarTitles.section, [buildLoadingIndicator("Claude разбирает грамматику…")])];
  }
  if (grammarState.error) {
    return [
      buildSection(grammarTitles.section, [
        buildElement("p", { className: "error-message", text: `Не получено: ${grammarState.error}` }),
        buildButton("Повторить", renderOptions.onExplainGrammar),
      ]),
    ];
  }
  const grammarResult = grammarState.result || {};
  const grammarPoints = Array.isArray(grammarResult.points) ? grammarResult.points : [];
  return [
    buildSection(grammarTitles.section, [
      grammarResult.structure ? buildElement("p", { text: grammarResult.structure }) : null,
      grammarPoints.length > 0
        ? buildElement(
          "ul",
          { className: "examples-list" },
          grammarPoints.map((grammarPoint) =>
            buildElement("li", {}, [
              buildElement("b", { className: "selectable-source", text: grammarPoint.fragment }),
              grammarPoint.explanation ? document.createTextNode(` — ${grammarPoint.explanation}`) : null,
            ]),
          ),
        )
        : null,
    ]),
    grammarResult.simplified
      ? buildSection(grammarTitles.simplified, [
        buildElement("p", { className: "selectable-source", text: grammarResult.simplified }),
        buildButton("🔊", () => speakEnglishText(grammarResult.simplified), "Произнести"),
      ])
      : null,
  ];
}

function renderSentenceView(panelElement, panelState, renderOptions) {
  let translationNodes;
  if (panelState.isLoading) {
    translationNodes = [buildLoadingIndicator("Перевод…")];
  } else if (panelState.translationError) {
    translationNodes = [buildElement("p", { className: "error-message", text: `Перевод недоступен: ${panelState.translationError}` })];
  } else {
    translationNodes = [buildElement("p", { className: "translated-sentence", text: panelState.translatedText })];
  }

  panelElement.append(
    buildElement("div", { className: "panel-top-bar" }, [
      panelState.parentPanelState ? buildButton(`← ${describeParentView(panelState.parentPanelState)}`, renderOptions.onBack) : null,
      buildElement("span", { className: "spacer" }),
      buildLanguageToggle(renderOptions.analysisLanguage, renderOptions.onLanguageChange),
    ]),
    buildElement("div", { className: "original-sentence-block" }, [
      buildElement("p", { className: "selectable-source", text: panelState.sourceText }),
      buildElement("div", { className: "phrase-actions" }, buildSpeechButtons(panelState.sourceText)),
    ]),
    buildSection("Перевод", translationNodes),
    ...buildGrammarNodes(panelState, renderOptions).filter(Boolean),
    buildElement("p", { className: "hint", text: "Выделите слово или фразу в оригинале, чтобы открыть разбор." }),
  );
}

function renderVocabularyView(panelElement, panelState, renderOptions) {
  const headerBar = buildElement("div", { className: "panel-top-bar" }, [
    buildElement("h2", { className: "panel-heading", text: "Мой словарь" }),
    buildElement("span", { className: "spacer" }),
    buildElement("a", {
      className: "panel-button",
      text: "⬇ Экспорт в Anki (CSV)",
      title: "Скачать все слова как CSV для импорта в Anki",
      attributes: { href: "/api/vocabulary/export.csv" },
    }),
  ]);
  panelElement.append(headerBar);

  if (panelState.isLoading) {
    panelElement.append(buildLoadingIndicator("Загрузка…"));
    return;
  }
  if (panelState.error) {
    panelElement.append(buildElement("p", { className: "error-message", text: panelState.error }));
    return;
  }
  if (panelState.entries.length === 0) {
    panelElement.append(buildElement("p", { className: "hint", text: "Пока пусто. Нажмите «☆ В словарь» в разборе слова, чтобы сохранить его вместе с предложением." }));
    return;
  }
  panelElement.append(buildElement("p", { className: "hint", text: `Слов: ${panelState.entries.length}` }));
  for (const vocabularyEntry of panelState.entries) {
    panelElement.append(
      buildElement("div", { className: "vocabulary-entry" }, [
        buildElement("div", { className: "vocabulary-entry-header" }, [
          buildElement("span", { className: "vocabulary-entry-phrase", text: vocabularyEntry.phrase }),
          buildElement("span", { className: "vocabulary-entry-translation", text: vocabularyEntry.translation_ru }),
        ]),
        vocabularyEntry.context_sentence
          ? buildElement("div", { className: "context-sentence", text: vocabularyEntry.context_sentence })
          : null,
        buildElement("div", { className: "phrase-actions" }, [
          buildButton("Открыть разбор", () => renderOptions.onOpenVocabularyEntry(vocabularyEntry)),
          buildButton("🔊", () => speakEnglishText(vocabularyEntry.phrase), "Произнести"),
          buildButton("Удалить", () => renderOptions.onDeleteVocabularyEntry(vocabularyEntry)),
        ]),
      ]),
    );
  }
}

function renderEmptyView(panelElement) {
  panelElement.append(
    buildElement("p", { className: "hint", text: "Выделите слово или фразу (до 4 слов) — откроется перевод и разбор." }),
    buildElement("p", { className: "hint", text: "Выделите предложение — откроется перевод." }),
  );
}

export function renderSidePanel(panelElement, panelState, renderOptions) {
  panelElement.replaceChildren();
  if (!panelState) {
    renderEmptyView(panelElement);
  } else if (panelState.mode === "phrase") {
    renderPhraseView(panelElement, panelState, renderOptions);
  } else if (panelState.mode === "vocabulary") {
    renderVocabularyView(panelElement, panelState, renderOptions);
  } else {
    renderSentenceView(panelElement, panelState, renderOptions);
  }
}
