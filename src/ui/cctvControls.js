import {
  _clearCctvFrame,
  _queueCctvFrame,
  _settleCctvFrame,
  _syncCctvSourceBadge,
} from './cctvFrames.js';
import {
  _activeCctvCameraId,
  _resetCctvCalibration,
  _beginCctvCalValueEdit,
  _syncCctvCalReadout,
} from './cctvCalibration.js';
import {
  _calBadgeLabel,
  _renderCctvState,
  _typeCctvSummary,
  _updateCctvSyncChip,
} from './cctvPresentation.js';
import { _initCctvPanel } from './cctvBindings.js';

/** Own camera-panel interaction and presentation; receive the camera port and application actions. */
export class CctvControls {
  constructor({ elements, cctv, actions }) {
    Object.assign(this, elements);
    this.cctv = cctv;
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._cctvUnsubscribe = null;
    this._cctvState = null;
    this._cctvSummaryTypingTimer = null;
    this._lastCctvSummaryText = '';
    this._lastSeenCctvActiveId = null;
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = false;
    this._cctvFrameRequestToken = 0;
    this._cctvFramePreloader = null;
    this._calibrationEdit = null;
    this._actionGeneration = 0;
    this._initCctvPanel();
    if (this._cctvVideo && typeof MutationObserver !== 'undefined') {
      this._videoVisibilityObserver = new MutationObserver(() =>
        this._renderCctvState(this._cctvState),
      );
      if (this._cctvPanel)
        this._videoVisibilityObserver.observe(this._cctvPanel, {
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      this.listen(document, 'visibilitychange', () =>
        this._renderCctvState(this._cctvState),
      );
    }
  }
  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }
  getState() {
    return this._cctvState;
  }
  connect() {
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    if (this.destroyed) return;
    this._cctvUnsubscribe = this.cctv.subscribe?.((state) =>
      this._renderCctvState(state),
    );
    if (this.cctv.getUIState) this._renderCctvState(this.cctv.getUIState());
  }
  _clearCctvFrame(...args) {
    return _clearCctvFrame.call(this, ...args);
  }
  _queueCctvFrame(...args) {
    return _queueCctvFrame.call(this, ...args);
  }
  _settleCctvFrame(...args) {
    return _settleCctvFrame.call(this, ...args);
  }
  _syncCctvSourceBadge(...args) {
    return _syncCctvSourceBadge.call(this, ...args);
  }
  _activeCctvCameraId(...args) {
    return _activeCctvCameraId.call(this, ...args);
  }
  _resetCctvCalibration(...args) {
    return _resetCctvCalibration.call(this, ...args);
  }
  _beginCctvCalValueEdit(...args) {
    return _beginCctvCalValueEdit.call(this, ...args);
  }
  _syncCctvCalReadout(...args) {
    return _syncCctvCalReadout.call(this, ...args);
  }
  _calBadgeLabel(...args) {
    return _calBadgeLabel.call(this, ...args);
  }
  _renderCctvState(...args) {
    return _renderCctvState.call(this, ...args);
  }
  _typeCctvSummary(...args) {
    return _typeCctvSummary.call(this, ...args);
  }
  _updateCctvSyncChip(...args) {
    return _updateCctvSyncChip.call(this, ...args);
  }
  _initCctvPanel(...args) {
    return _initCctvPanel.call(this, ...args);
  }
  isViewerExpanded() {
    return (
      this._cctvFrameWrap?.classList.contains('cctv-frame-wrap-expanded') ===
      true
    );
  }
  setViewerExpanded(expanded) {
    const wrap = this._cctvFrameWrap;
    if (!wrap) return;
    const on = expanded === true;
    if (on === this.isViewerExpanded()) return;
    if (on) {
      this._wrapHome = { parent: wrap.parentNode, next: wrap.nextSibling };
      this._expandReturnFocus =
        typeof document !== 'undefined' ? document.activeElement : null;
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(wrap);
      }
      wrap.classList.add('cctv-frame-wrap-expanded');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', 'CCTV Fullscreen View');
      wrap.tabIndex = -1;
      wrap.focus?.({ preventScroll: true });
      if (this._cctvFullscreenCloseBtn)
        this._cctvFullscreenCloseBtn.hidden = false;
      if (this._cctvFullscreenBtn) {
        this._cctvFullscreenBtn.textContent = '✕ CLOSE';
        this._cctvFullscreenBtn.title = 'Exit fullscreen view (Esc)';
      }
      try {
        if (
          typeof document !== 'undefined' &&
          !document.fullscreenElement &&
          wrap.requestFullscreen
        ) {
          wrap.requestFullscreen().catch(() => {});
        }
      } catch {}
    } else {
      wrap.classList.remove('cctv-frame-wrap-expanded');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-modal');
      wrap.removeAttribute('aria-label');
      wrap.removeAttribute('tabindex');
      if (this._wrapHome?.parent) {
        this._wrapHome.parent.insertBefore(wrap, this._wrapHome.next);
      }
      this._wrapHome = null;
      if (this._cctvFullscreenCloseBtn)
        this._cctvFullscreenCloseBtn.hidden = true;
      if (this._cctvFullscreenBtn) {
        this._cctvFullscreenBtn.textContent = '⤢ FULLSCREEN';
        this._cctvFullscreenBtn.title = 'Toggle Fullscreen view (Esc)';
      }
      try {
        if (
          typeof document !== 'undefined' &&
          document.fullscreenElement &&
          document.exitFullscreen
        ) {
          document.exitFullscreen().catch(() => {});
        }
      } catch {}
      const target = this._expandReturnFocus;
      this._expandReturnFocus = null;
      if (target?.isConnected && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.isViewerExpanded()) {
      this.setViewerExpanded(false);
    }
    this._cctvVideoSurface?.stop();
    this._videoVisibilityObserver?.disconnect();
    this._actionGeneration++;
    this.listeners.abort();
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    this._calibrationEdit?.(false);
    this._clearCctvFrame();
    clearInterval(this._cctvSummaryTypingTimer);
    clearTimeout(this._cctvChipHideTimer);
    this._cctvSummaryTypingTimer = null;
    this._cctvChipHideTimer = null;
    this._cctvSyncChip?.classList.remove('visible');
  }
}
