// A small translation bubble shown right above the selected text, for the quick
// "what is it, how does it sound, move on" case where the side panel is not even read.
// It lives inside the scrolling viewer container, so it scrolls together with the page.

const POPUP_GAP_PIXELS = 8;

let popupElement = null;
let popupContainerElement = null;
let currentPopupToken = 0;

function ensurePopupElement(containerElement) {
  if (popupElement && popupContainerElement === containerElement) {
    return popupElement;
  }
  popupContainerElement = containerElement;
  popupElement = document.createElement("div");
  popupElement.id = "selectionPopup";
  popupElement.hidden = true;
  // Pressing inside the bubble must not start a new selection in the book or close it.
  popupElement.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());
  containerElement.append(popupElement);
  return popupElement;
}

function placePopup(containerElement, anchorRect) {
  const containerRect = containerElement.getBoundingClientRect();
  const anchorLeftInContainer = anchorRect.left - containerRect.left + containerElement.scrollLeft;
  const anchorTopInContainer = anchorRect.top - containerRect.top + containerElement.scrollTop;
  const anchorBottomInContainer = anchorRect.bottom - containerRect.top + containerElement.scrollTop;

  const popupWidth = popupElement.offsetWidth;
  const popupHeight = popupElement.offsetHeight;
  const visibleLeft = containerElement.scrollLeft + POPUP_GAP_PIXELS;
  const visibleRight = containerElement.scrollLeft + containerElement.clientWidth - POPUP_GAP_PIXELS;
  const centeredLeft = anchorLeftInContainer + anchorRect.width / 2 - popupWidth / 2;
  const clampedLeft = Math.max(visibleLeft, Math.min(centeredLeft, visibleRight - popupWidth));

  // Above the selection by default; below it when the line is at the top of the view.
  const topAbove = anchorTopInContainer - popupHeight - POPUP_GAP_PIXELS;
  const fitsAbove = topAbove >= containerElement.scrollTop;
  const popupTop = fitsAbove ? topAbove : anchorBottomInContainer + POPUP_GAP_PIXELS;

  popupElement.style.left = `${Math.round(clampedLeft)}px`;
  popupElement.style.top = `${Math.round(popupTop)}px`;
}

function renderPopupText(translationText, isPending, isError) {
  popupElement.className = isPending ? "is-pending" : isError ? "is-error" : "";
  popupElement.textContent = translationText;
}

export function showSelectionPopup(containerElement, anchorRect) {
  ensurePopupElement(containerElement);
  currentPopupToken += 1;
  const popupToken = currentPopupToken;
  popupElement.hidden = false;
  renderPopupText("…", true, false);
  placePopup(containerElement, anchorRect);

  // The returned callbacks ignore late answers for a selection that is no longer current.
  return {
    showTranslation(translationText) {
      if (popupToken !== currentPopupToken || popupElement.hidden) {
        return;
      }
      renderPopupText(translationText || "—", false, false);
      placePopup(containerElement, anchorRect);
    },
    showFailure() {
      if (popupToken !== currentPopupToken || popupElement.hidden) {
        return;
      }
      renderPopupText("перевод недоступен", false, true);
      placePopup(containerElement, anchorRect);
    },
  };
}

export function hideSelectionPopup() {
  currentPopupToken += 1;
  if (popupElement) {
    popupElement.hidden = true;
  }
}
