'use strict';

class StorageManager {
  constructor() {
    this.dbName = 'StudyHubDB';
    this.dbVersion = 2;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('folders')) {
          const folderStore = db.createObjectStore('folders', { keyPath: 'id' });
          folderStore.createIndex('createdAt', 'createdAt', { unique: false });
        } else {
          const folderStore = event.target.transaction.objectStore('folders');
          if (!folderStore.indexNames.contains('createdAt')) {
            folderStore.createIndex('createdAt', 'createdAt', { unique: false });
          }
        }

        let fileStore;
        if (!db.objectStoreNames.contains('files')) {
          fileStore = db.createObjectStore('files', { keyPath: 'id' });
        } else {
          fileStore = event.target.transaction.objectStore('files');
        }

        if (!fileStore.indexNames.contains('folderId')) {
          fileStore.createIndex('folderId', 'folderId', { unique: false });
        }
        if (!fileStore.indexNames.contains('favorite')) {
          fileStore.createIndex('favorite', 'favorite', { unique: false });
        }
        if (!fileStore.indexNames.contains('lastOpened')) {
          fileStore.createIndex('lastOpened', 'lastOpened', { unique: false });
        }

        if (!db.objectStoreNames.contains('todos')) {
          const todoStore = db.createObjectStore('todos', { keyPath: 'id' });
          todoStore.createIndex('dateStr', 'dateStr', { unique: false });
          todoStore.createIndex('completed', 'completed', { unique: false });
        } else {
          const todoStore = event.target.transaction.objectStore('todos');
          if (!todoStore.indexNames.contains('dateStr')) {
            todoStore.createIndex('dateStr', 'dateStr', { unique: false });
          }
          if (!todoStore.indexNames.contains('completed')) {
            todoStore.createIndex('completed', 'completed', { unique: false });
          }
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.db.onversionchange = () => {
          this.db.close();
        };
        resolve(this.db);
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  async runTransaction(storeName, mode, callback) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

      result = callback(store);
    });
  }

  async getAllFolders() {
    return this.runTransaction('folders', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async getFolderById(id) {
    return this.runTransaction('folders', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const req = store.get(id);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async saveFolder(folder) {
    return this.runTransaction('folders', 'readwrite', (store) => store.put(folder));
  }

  async deleteFolder(folderId) {
    await this.runTransaction('folders', 'readwrite', (store) => store.delete(folderId));
    const files = await this.getFilesByFolder(folderId);
    for (const file of files) {
      await this.deleteFile(file.id);
    }
  }

  async saveFile(file) {
    return this.runTransaction('files', 'readwrite', (store) => store.put(file));
  }

  async getFileById(id) {
    return this.runTransaction('files', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const req = store.get(id);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async getFilesByFolder(folderId) {
    return this.runTransaction('files', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const index = store.index('folderId');
        const req = index.getAll(folderId);
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async getAllFiles() {
    return this.runTransaction('files', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async getFavoriteFiles() {
    return this.runTransaction('files', 'readonly', (store) => {
      return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const files = request.result || [];
          resolve(files.filter(file => file.favorite === true));
        };
        request.onerror = () => {
          reject(request.error);
        };
      });
    });
  }

  async getRecentFiles(limit = 3) {
    return this.runTransaction('files', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const results = [];
        const max = Math.max(1, Number(limit) || 3);
        const index = store.index('lastOpened');
        const req = index.openCursor(null, 'prev');

        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || results.length >= max) {
            res(results);
            return;
          }
          if (cursor.value.lastOpened && cursor.value.lastOpened > 0) {
            results.push(cursor.value);
          }
          cursor.continue();
        };

        req.onerror = () => reject(req.error);
      });
    });
  }

  async recordRecentFile(id) {
    const file = await this.getFileById(id);
    if (!file) return null;
    file.lastOpened = Date.now();
    await this.saveFile(file);
    return file;
  }

  async clearRecentFiles() {
    const allFiles = await this.getAllFiles();
    for (const file of allFiles) {
      if (file.lastOpened) {
        file.lastOpened = 0;
        await this.saveFile(file);
      }
    }
  }

  async updateFileMetadata(id, updates) {
    const file = await this.getFileById(id);
    if (!file) return null;
    Object.assign(file, updates);
    await this.saveFile(file);
    return file;
  }

  async renameFolder(folderId, newName) {
    const folder = await this.getFolderById(folderId);
    if (!folder) return null;
    folder.name = newName;
    await this.saveFolder(folder);
    const files = await this.getFilesByFolder(folderId);
    for (const file of files) {
      file.folderName = newName;
      await this.saveFile(file);
    }
    return folder;
  }

  async deleteFile(id) {
    return this.runTransaction('files', 'readwrite', (store) => store.delete(id));
  }

  async getAllTodos() {
    return this.runTransaction('todos', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async getTodosByDate(dateStr) {
    return this.runTransaction('todos', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const index = store.index('dateStr');
        const req = index.getAll(dateStr);
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async saveTodo(todo) {
    return this.runTransaction('todos', 'readwrite', (store) => store.put(todo));
  }

  async deleteTodo(id) {
    return this.runTransaction('todos', 'readwrite', (store) => store.delete(id));
  }

  async getSetting(key, defaultValue = null) {
    return this.runTransaction('settings', 'readonly', (store) => {
      return new Promise((res, reject) => {
        const req = store.get(key);
        req.onsuccess = () => {
          res(req.result ? req.result.value : defaultValue);
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  async setSetting(key, value) {
    return this.runTransaction('settings', 'readwrite', (store) =>
      store.put({ key, value })
    );
  }

  async clearAllData() {
    for (const name of ['folders', 'files', 'todos', 'settings']) {
      await this.runTransaction(name, 'readwrite', (store) => store.clear());
    }
  }
}

const storage = new StorageManager();

const AppState = {
  currentView: 'dashboard',
  currentFolderId: null,
  activeFilter: 'all'
};

function enableTabStripMouseDrag() {
  const strip = document.getElementById('browser-tab-strip');
  if (!strip) return;

  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;
  let hasDragged = false;

  strip.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.browser-tab-close')) return;
    isDown = true;
    hasDragged = false;
    startX = e.pageX - strip.offsetLeft;
    scrollLeft = strip.scrollLeft;
  });

  window.addEventListener('mouseup', () => {
    if (!isDown) return;
    isDown = false;
    strip.classList.remove('is-dragging');
    setTimeout(() => {
      hasDragged = false;
    }, 60);
  });

  strip.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    const x = e.pageX - strip.offsetLeft;
    const dist = x - startX;
    if (Math.abs(dist) > 4) {
      hasDragged = true;
      strip.classList.add('is-dragging');
      e.preventDefault();
      strip.scrollLeft = scrollLeft - dist;
    }
  });

  strip.addEventListener('click', (e) => {
    if (hasDragged) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

class TabController {
  static tabs = [];
  static activeTabId = 'main';

  static init() {
    const mainTabBtn = document.getElementById('tab-button-main');
    if (mainTabBtn) {
      mainTabBtn.addEventListener('click', () => {
        TabController.activateTab('main');
        try {
          history.pushState(
            { view: AppState.currentView || 'dashboard' },
            '',
            '#' + (AppState.currentView || 'dashboard')
          );
        } catch (_) {}
      });
    }
  }

  static async openFileTab(fileId) {
    const existing = TabController.tabs.find(t => t.fileId === fileId);
    if (existing) {
      TabController.activateTab(existing.id);
      try {
        history.pushState(
          { tabId: existing.id, fileId: fileId },
          '',
          `#doc-${existing.id}`
        );
      } catch (_) {}
      return;
    }

    const file = await storage.getFileById(fileId);
    if (!file || !file.blob) {
      alert('Error: File content could not be located.');
      return;
    }

    await storage.recordRecentFile(fileId);
    FileController.renderRecentFiles();

    const tabId = 'tab_' + Date.now();
    const tabData = {
      id: tabId,
      fileId: file.id,
      title: file.name,
      type: file.type,
      folderId: file.folderId,
      blob: file.blob,
      lastPage: Number(file.lastPage) || 1,
      lastZoom: Number(file.lastZoom) || 100
    };

    TabController.tabs.push(tabData);
    ViewModeController.updateLockState();
    TabController.renderTabButton(tabData);
    TabController.createTabPane(tabData);

    try {
      history.pushState(
        { tabId: tabId, fileId: file.id },
        '',
        `#doc-${tabId}`
      );
    } catch (_) {}

    TabController.activateTab(tabId);

    requestAnimationFrame(() => {
      if (tabData.type === 'pdf') {
        tabData.engine = new TabbedPdfViewer(tabData);
        tabData.engine.init();
      } else {
        tabData.engine = new TabbedPhotoViewer(tabData);
        tabData.engine.init();
      }
    });
  }

  static renderTabButton(tab) {
    const strip = document.getElementById('browser-tab-strip');
    if (!strip) return;

    const btn = document.createElement('div');
    btn.className = 'browser-tab-item';
    btn.id = `tab-button-${tab.id}`;
    btn.dataset.tabId = tab.id;

    const isPdf = tab.type === 'pdf';
    btn.innerHTML = `
      <span class="browser-tab-icon">${isPdf ? '📄' : '🖼️'}</span>
      <span class="browser-tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
      <button class="browser-tab-close" title="Close Tab">&times;</button>
    `;

    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('browser-tab-close')) {
        e.stopPropagation();
        TabController.closeTab(tab.id);
      } else {
        TabController.activateTab(tab.id);
        try {
          history.pushState(
            { tabId: tab.id, fileId: tab.fileId },
            '',
            `#doc-${tab.id}`
          );
        } catch (_) {}
      }
    });

    strip.appendChild(btn);
    btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest' });
  }

  static createTabPane(tab) {
    const wrapper = document.getElementById('tab-panes-wrapper');
    if (!wrapper) return;

    const pane = document.createElement('div');
    pane.className = 'tab-content-pane';
    pane.id = `pane-${tab.id}`;

    if (tab.type === 'pdf') {
      pane.innerHTML = `
        <div class="doc-viewer-workspace" id="workspace-${tab.id}">
          <div class="doc-top-bar">
            <div style="display: flex; align-items: center; gap: 8px; pointer-events: auto;">
              <button class="btn btn-danger btn-sm doc-exit-btn" id="exit-btn-${tab.id}" title="Exit Document" style="border-radius: 20px; font-weight: 600; padding: 5px 12px; gap: 4px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                <span>Exit</span>
              </button>
              <div class="doc-floating-widget">
                <button class="doc-tool-btn" id="zoom-out-${tab.id}" title="Zoom Out">−</button>
                <span class="doc-zoom-label" id="zoom-label-${tab.id}">${tab.lastZoom}%</span>
                <button class="doc-tool-btn" id="zoom-in-${tab.id}" title="Zoom In">+</button>
                <button class="doc-btn-fit" id="zoom-fit-${tab.id}">Fit</button>
              </div>
            </div>
            <button class="history-bookmark-btn" id="history-btn-${tab.id}" title="Return to your saved page">
              🕒 <span id="history-page-num-${tab.id}">${tab.lastPage}</span>
            </button>
          </div>
          <div class="pdf-scroll-viewport" id="scroll-container-${tab.id}">
            <div style="color: #CBD5E1; padding-top: 50px; font-size: 13px; text-align: center;">Loading pages…</div>
          </div>
          <div class="doc-bottom-bar">
            <div class="page-jump-widget">
              <span>Page:</span>
              <input type="number" min="1" value="1" id="jump-input-${tab.id}" />
              <span>/ <span id="total-pages-${tab.id}">--</span></span>
              <button class="btn-page-go" id="jump-btn-${tab.id}">Go</button>
            </div>
          </div>
        </div>
      `;
    } else {
      pane.innerHTML = `
        <div class="doc-viewer-workspace">
          <div class="doc-top-bar">
            <div style="display: flex; align-items: center; gap: 8px; pointer-events: auto;">
              <button class="btn btn-danger btn-sm doc-exit-btn" id="exit-btn-${tab.id}" title="Exit Document" style="border-radius: 20px; font-weight: 600; padding: 5px 12px; gap: 4px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                <span>Exit</span>
              </button>
              <div class="doc-floating-widget">
                <button class="doc-tool-btn" id="photo-zoom-out-${tab.id}">−</button>
                <span class="doc-zoom-label" id="photo-zoom-label-${tab.id}">100%</span>
                <button class="doc-tool-btn" id="photo-zoom-in-${tab.id}">+</button>
                <button class="doc-btn-fit" id="photo-zoom-reset-${tab.id}">Reset</button>
              </div>
            </div>
          </div>
          <div class="photo-viewport" id="photo-viewport-${tab.id}">
            <div class="photo-zoom-container" id="photo-pan-container-${tab.id}">
              <img id="photo-img-${tab.id}" alt="Preview" draggable="false" />
            </div>
          </div>
        </div>
      `;
    }

    wrapper.appendChild(pane);
    document.getElementById(`exit-btn-${tab.id}`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      TabController.closeTab(tab.id);
    });
  }

  static activateTab(tabId) {
    TabController.activeTabId = tabId;
    document.querySelectorAll('.browser-tab-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tabId === tabId);
    });

    const targetPaneId = (tabId === 'main' || tabId === 'tab-main') ? 'pane-main' : `pane-${tabId}`;
    document.querySelectorAll('.tab-content-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === targetPaneId);
    });

    if (tabId === 'main' || tabId === 'tab-main') {
      const currentView = AppState.currentView || 'dashboard';
      const viewPanel = document.getElementById(`view-${currentView}`);
      if (viewPanel) {
        document.querySelectorAll('.view-panel').forEach(p => {
          p.classList.remove('active');
        });
        viewPanel.classList.add('active');
      }
    } else {
      const tab = TabController.tabs.find(t => t.id === tabId);
      if (tab && tab.engine && typeof tab.engine.onTabShown === 'function') {
        tab.engine.onTabShown();
      }
    }
  }

  static closeTab(tabId) {
    const index = TabController.tabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    const tab = TabController.tabs[index];
    if (tab.engine && typeof tab.engine.destroy === 'function') {
      tab.engine.destroy();
    }

    document.getElementById(`tab-button-${tabId}`)?.remove();
    document.getElementById(`pane-${tabId}`)?.remove();
    TabController.tabs.splice(index, 1);
    ViewModeController.updateLockState();

    if (TabController.activeTabId === tabId) {
      if (TabController.tabs.length > 0) {
        const nextTab = TabController.tabs[Math.max(0, index - 1)];
        TabController.activateTab(nextTab.id);
        try {
          history.replaceState(
            { tabId: nextTab.id, fileId: nextTab.fileId },
            '',
            `#doc-${nextTab.id}`
          );
        } catch (_) {}
      } else {
        TabController.activateTab('main');
        try {
          history.replaceState(
            { view: AppState.currentView || 'dashboard' },
            '',
            '#' + (AppState.currentView || 'dashboard')
          );
        } catch (_) {}
      }
    }
  }

  static closeTabsForFile(fileId) {
    const ids = TabController.tabs
      .filter(t => t.fileId === fileId)
      .map(t => t.id);
    ids.forEach(id => TabController.closeTab(id));
  }

  static closeTabsForFolder(folderId) {
    const ids = TabController.tabs
      .filter(t => t.folderId === folderId)
      .map(t => t.id);
    ids.forEach(id => TabController.closeTab(id));
  }
}

class TabbedPdfViewer {
  constructor(tabData) {
    this.tab = tabData;
    this.pdfDoc = null;
    this.totalPages = 0;
    this.savedHistoryPage = Number(tabData.lastPage) || 1;
    this.currentPage = 1;
    this.currentZoom = Number(tabData.lastZoom) || 100;
    this.pageAspectRatios = {};
    this.renderObserver = null;
    this.saveDebounce = null;
    this.canTrack = false;
    this.scrollRaf = null;
    this.handleScroll = this.onScroll.bind(this);
    this.handleMouseUp = null;
    this.handlePdfMouseDown = null;
    this.handlePdfMouseMove = null;
  }

  async init() {
    if (!window.pdfjsLib) {
      const container = document.getElementById(`scroll-container-${this.tab.id}`);
      if (container) {
        container.innerHTML = '<div style="color:#EF4444; padding:30px;">PDF viewer library not available. Connect to internet.</div>';
      }
      return;
    }

    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.9.359/pdf.worker.min.js';
    } catch (_) {
      pdfjsLib.disableWorker = true;
    }

    try {
      let uint8;
      if (this.tab.blob.arrayBuffer) {
        const buffer = await this.tab.blob.arrayBuffer();
        uint8 = new Uint8Array(buffer);
      } else {
        uint8 = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(new Uint8Array(fr.result));
          fr.onerror = rej;
          fr.readAsArrayBuffer(this.tab.blob);
        });
      }

      this.pdfDoc = await pdfjsLib.getDocument({
        data: uint8,
        disableAutoFetch: true,
        disableStream: true
      }).promise;

      this.totalPages = this.pdfDoc.numPages;

      const totalPagesElem = document.getElementById(`total-pages-${this.tab.id}`);
      if (totalPagesElem) totalPagesElem.textContent = this.totalPages;

      const jumpInput = document.getElementById(`jump-input-${this.tab.id}`);
      if (jumpInput) {
        jumpInput.max = this.totalPages;
        jumpInput.value = 1;
      }

      const historyNumElem = document.getElementById(`history-page-num-${this.tab.id}`);
      if (historyNumElem) historyNumElem.textContent = this.savedHistoryPage;

      this.setupControls();
      await this.buildPageSlots();
      this.setupIntersectionObserver();
      this.setupMouseDragScroll();

      const firstSlot = document.getElementById(`pdf-slot-${this.tab.id}-1`);
      if (firstSlot) await this.renderPageCanvas(1, firstSlot);

      const container = document.getElementById(`scroll-container-${this.tab.id}`);
      if (container) {
        container.scrollTop = 0;
        container.addEventListener('scroll', this.handleScroll, { passive: true });
      }

      setTimeout(() => {
        this.canTrack = true;
      }, 400);
    } catch (err) {
      console.error('PDF load error:', err);
      const container = document.getElementById(`scroll-container-${this.tab.id}`);
      if (container) {
        container.innerHTML = `<div style="color:#EF4444; padding:30px;">Unable to render PDF: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  setupControls() {
    const id = this.tab.id;
    document.getElementById(`zoom-in-${id}`)?.addEventListener('click', () => this.changeZoom(25));
    document.getElementById(`zoom-out-${id}`)?.addEventListener('click', () => this.changeZoom(-25));
    document.getElementById(`zoom-fit-${id}`)?.addEventListener('click', () => this.fitWidth());
    document.getElementById(`history-btn-${id}`)?.addEventListener('click', () => {
      if (this.savedHistoryPage >= 1 && this.savedHistoryPage <= this.totalPages) {
        this.jumpToPage(this.savedHistoryPage, true);
      }
    });

    const jumpBtn = document.getElementById(`jump-btn-${id}`);
    const jumpInput = document.getElementById(`jump-input-${id}`);
    if (jumpBtn && jumpInput) {
      jumpBtn.addEventListener('click', () => {
        const p = parseInt(jumpInput.value, 10);
        if (p >= 1 && p <= this.totalPages) {
          this.jumpToPage(p, true);
        }
      });
      jumpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const p = parseInt(jumpInput.value, 10);
          if (p >= 1 && p <= this.totalPages) {
            this.jumpToPage(p, true);
          }
        }
      });
    }
  }

  setupMouseDragScroll() {
    const container = document.getElementById(`scroll-container-${this.tab.id}`);
    if (!container) return;

    let isDown = false;
    let startY = 0;
    let scrollTop = 0;

    const handleMouseDown = (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, a')) return;
      isDown = true;
      container.style.cursor = 'grab';
      startY = e.pageY - container.offsetTop;
      scrollTop = container.scrollTop;
    };

    const handleMouseMove = (e) => {
      if (!isDown) return;
      e.preventDefault();
      container.style.cursor = 'grabbing';
      const y = e.pageY - container.offsetTop;
      container.scrollTop = scrollTop - (y - startY);
    };

    this.handleMouseUp = () => {
      if (!isDown) return;
      isDown = false;
      container.style.cursor = '';
    };

    this.handlePdfMouseDown = handleMouseDown;
    this.handlePdfMouseMove = handleMouseMove;

    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', this.handleMouseUp);
  }

  async buildPageSlots() {
    const container = document.getElementById(`scroll-container-${this.tab.id}`);
    if (!container || !this.pdfDoc) return;

    container.innerHTML = '';
    const availableWidth = container.clientWidth > 50 ? container.clientWidth : window.innerWidth - 32;
    const baseWidth = Math.min(800, Math.max(300, availableWidth - 32));
    const scaledWidth = Math.round(baseWidth * (this.currentZoom / 100));

    for (let i = 1; i <= this.totalPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const baseVp = page.getViewport({ scale: 1 });
      const aspect = baseVp.height / baseVp.width;
      this.pageAspectRatios[i] = aspect;

      const slot = document.createElement('div');
      slot.className = 'pdf-page-slot';
      slot.id = `pdf-slot-${this.tab.id}-${i}`;
      slot.dataset.pageNum = i;
      slot.style.width = `${scaledWidth}px`;
      slot.style.height = `${Math.round(scaledWidth * aspect)}px`;
      slot.innerHTML = `<span class="pdf-page-loading-ph">Page ${i}</span>`;
      container.appendChild(slot);
    }
  }

  setupIntersectionObserver() {
    const container = document.getElementById(`scroll-container-${this.tab.id}`);
    if (!container) return;

    if (this.renderObserver) {
      this.renderObserver.disconnect();
    }

    this.renderObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.dataset.pageNum);
            this.renderPageCanvas(pageNum, entry.target);
          }
        });
      },
      {
        root: container,
        rootMargin: '350px 0px',
        threshold: 0.01
      }
    );

    container.querySelectorAll('.pdf-page-slot').forEach(slot => {
      this.renderObserver.observe(slot);
    });
  }

  onScroll() {
    if (!this.canTrack) return;
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = requestAnimationFrame(() => {
      this.updateCurrentVisiblePage();
    });
  }

  updateCurrentVisiblePage() {
    const container = document.getElementById(`scroll-container-${this.tab.id}`);
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const focalY = containerRect.top + containerRect.height * 0.35;
    const slots = container.querySelectorAll('.pdf-page-slot');

    let visiblePage = 1;
    let minDistance = Infinity;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const rect = slot.getBoundingClientRect();
      const slotCenterY = rect.top + rect.height / 2;
      const dist = Math.abs(slotCenterY - focalY);

      if (dist < minDistance) {
        minDistance = dist;
        visiblePage = Number(slot.dataset.pageNum);
      }
    }

    if (visiblePage !== this.currentPage) {
      this.currentPage = visiblePage;
      const jumpInput = document.getElementById(`jump-input-${this.tab.id}`);
      if (jumpInput && document.activeElement !== jumpInput) {
        jumpInput.value = visiblePage;
      }
      if (visiblePage > 1) {
        this.savedHistoryPage = visiblePage;
        const histLabel = document.getElementById(`history-page-num-${this.tab.id}`);
        if (histLabel) histLabel.textContent = visiblePage;
        this.tab.lastPage = visiblePage;
        this.saveReadingPosition(visiblePage);
      }
    }
  }

  async renderPageCanvas(pageNum, slotElement) {
    if (slotElement.querySelector('canvas')) return;

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const baseVp = page.getViewport({ scale: 1 });
      this.pageAspectRatios[pageNum] = baseVp.height / baseVp.width;

      const slotWidth = parseFloat(slotElement.style.width);
      const computedScale = slotWidth / baseVp.width;
      const viewport = page.getViewport({ scale: computedScale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';

      const ctx = canvas.getContext('2d', { alpha: false });
      slotElement.innerHTML = '';
      slotElement.appendChild(canvas);

      await page.render({
        canvasContext: ctx,
        viewport: viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      }).promise;
    } catch (err) {
      slotElement.innerHTML = `<span class="pdf-page-loading-ph">Unable to render page ${pageNum}</span>`;
      console.error(`PDF page ${pageNum} render error:`, err);
    }
  }

  jumpToPage(pageNum, smooth = true) {
    const slot = document.getElementById(`pdf-slot-${this.tab.id}-${pageNum}`);
    const container = document.getElementById(`scroll-container-${this.tab.id}`);

    if (slot && container) {
      container.scrollTo({
        top: slot.offsetTop - 50,
        behavior: smooth ? 'smooth' : 'auto'
      });

      this.currentPage = pageNum;
      const jumpInput = document.getElementById(`jump-input-${this.tab.id}`);
      if (jumpInput) jumpInput.value = pageNum;

      if (pageNum > 1) {
        this.savedHistoryPage = pageNum;
        const histLabel = document.getElementById(`history-page-num-${this.tab.id}`);
        if (histLabel) histLabel.textContent = pageNum;
        this.tab.lastPage = pageNum;
        this.saveReadingPosition(pageNum);
      }
    }
  }

  changeZoom(delta) {
    const next = Math.min(300, Math.max(50, this.currentZoom + delta));
    if (next === this.currentZoom) return;

    this.currentZoom = next;
    this.tab.lastZoom = next;
    const label = document.getElementById(`zoom-label-${this.tab.id}`);
    if (label) label.textContent = `${next}%`;
    this.reapplyZoomToSlots();
  }

  fitWidth() {
    this.currentZoom = 100;
    this.tab.lastZoom = 100;
    const label = document.getElementById(`zoom-label-${this.tab.id}`);
    if (label) label.textContent = '100%';
    this.reapplyZoomToSlots();
  }

  reapplyZoomToSlots() {
    const container = document.getElementById(`scroll-container-${this.tab.id}`);
    if (!container) return;

    const availableWidth = container.clientWidth > 50 ? container.clientWidth : window.innerWidth - 32;
    const baseWidth = Math.min(800, Math.max(300, availableWidth - 32));
    const scaledWidth = Math.round(baseWidth * (this.currentZoom / 100));

    container.querySelectorAll('.pdf-page-slot').forEach(slot => {
      const p = Number(slot.dataset.pageNum);
      const aspect = this.pageAspectRatios[p] || 1.414;
      slot.style.width = `${scaledWidth}px`;
      slot.style.height = `${Math.round(scaledWidth * aspect)}px`;
      slot.innerHTML = `<span class="pdf-page-loading-ph">Page ${p}</span>`;
    });

    this.setupIntersectionObserver();
    this.saveReadingPosition(this.currentPage);
  }

  saveReadingPosition(pageToSave) {
    clearTimeout(this.saveDebounce);
    this.saveDebounce = setTimeout(async () => {
      try {
        await storage.updateFileMetadata(this.tab.fileId, {
          lastPage: pageToSave || this.currentPage,
          lastZoom: this.currentZoom
        });
      } catch (_) {}
    }, 300);
  }

  onTabShown() {
    this.setupIntersectionObserver();
  }

  destroy() {
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    clearTimeout(this.saveDebounce);

    const container = document.getElementById(`scroll-container-${this.tab.id}`);
    if (container) {
      container.removeEventListener('scroll', this.handleScroll);
      if (this.handlePdfMouseDown) container.removeEventListener('mousedown', this.handlePdfMouseDown);
      if (this.handlePdfMouseMove) container.removeEventListener('mousemove', this.handlePdfMouseMove);
    }

    if (this.handleMouseUp) window.removeEventListener('mouseup', this.handleMouseUp);
    if (this.renderObserver) this.renderObserver.disconnect();
    if (this.pdfDoc) {
      try {
        this.pdfDoc.destroy();
      } catch (_) {}
    }
  }
}

class TabbedPhotoViewer {
  constructor(tabData) {
    this.tab = tabData;
    this.scale = 1;
    this.posX = 0;
    this.posY = 0;
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.objectUrl = null;
    this.viewport = null;
    this.handlePointerDown = null;
    this.handlePointerMove = null;
    this.handlePointerUp = null;
    this.handleWheel = null;
  }

  init() {
    const img = document.getElementById(`photo-img-${this.tab.id}`);
    const viewport = document.getElementById(`photo-viewport-${this.tab.id}`);
    const zoomIn = document.getElementById(`photo-zoom-in-${this.tab.id}`);
    const zoomOut = document.getElementById(`photo-zoom-out-${this.tab.id}`);
    const resetBtn = document.getElementById(`photo-zoom-reset-${this.tab.id}`);

    if (!img || !viewport) return;
    this.viewport = viewport;

    this.objectUrl = URL.createObjectURL(this.tab.blob);
    img.src = this.objectUrl;

    zoomIn?.addEventListener('click', () => this.zoom(1.25));
    zoomOut?.addEventListener('click', () => this.zoom(0.8));
    resetBtn?.addEventListener('click', () => this.reset());

    this.handlePointerDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, input, select, a')) return;
      this.isDragging = true;
      this.startX = e.clientX - this.posX;
      this.startY = e.clientY - this.posY;
      viewport.classList.add('is-dragging');
      viewport.setPointerCapture?.(e.pointerId);
    };

    this.handlePointerMove = (e) => {
      if (!this.isDragging) return;
      this.posX = e.clientX - this.startX;
      this.posY = e.clientY - this.startY;
      this.applyTransform();
    };

    this.handlePointerUp = (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      viewport.classList.remove('is-dragging');
      try {
        viewport.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
    };

    this.handleWheel = (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.15 : 0.85);
    };

    viewport.addEventListener('pointerdown', this.handlePointerDown);
    viewport.addEventListener('pointermove', this.handlePointerMove);
    viewport.addEventListener('pointerup', this.handlePointerUp);
    viewport.addEventListener('pointercancel', this.handlePointerUp);
    viewport.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  zoom(factor) {
    this.scale = Math.min(6, Math.max(0.4, this.scale * factor));
    this.applyTransform();
  }

  reset() {
    this.scale = 1;
    this.posX = 0;
    this.posY = 0;
    this.applyTransform();
  }

  applyTransform() {
    const container = document.getElementById(`photo-pan-container-${this.tab.id}`);
    const label = document.getElementById(`photo-zoom-label-${this.tab.id}`);
    if (container) {
      container.style.transform = `translate3d(${this.posX}px, ${this.posY}px, 0) scale(${this.scale})`;
    }
    if (label) {
      label.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }

  destroy() {
    if (this.viewport) {
      this.viewport.removeEventListener('pointerdown', this.handlePointerDown);
      this.viewport.removeEventListener('pointermove', this.handlePointerMove);
      this.viewport.removeEventListener('pointerup', this.handlePointerUp);
      this.viewport.removeEventListener('pointercancel', this.handlePointerUp);
      this.viewport.removeEventListener('wheel', this.handleWheel);
      this.viewport.classList.remove('is-dragging');
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
  }
}

class AppRouter {
  static openSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('active');
  }

  static closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }

  static init() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        AppRouter.renderView(btn.dataset.view, {}, true);
      });
    });

    const mobileBtn = document.getElementById('mobile-menu-toggle');
    const overlay = document.getElementById('sidebar-overlay');

    if (mobileBtn) {
      mobileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        AppRouter.openSidebar();
      });
    }

    if (overlay) {
      overlay.addEventListener('click', () => AppRouter.closeSidebar());
    }

    document.getElementById('btn-back-to-dashboard')?.addEventListener('click', () => {
      history.back();
    });
  }

  static renderView(viewName, params = {}, pushToHistory = true) {
    AppState.currentView = viewName;

    if (pushToHistory) {
      try {
        const hash = '#' + viewName + (params.folderId ? `-${params.folderId}` : '');
        history.pushState({ view: viewName, params: params }, '', hash);
      } catch (_) {}
    }

    if (TabController.activeTabId !== 'main') {
      TabController.activateTab('main');
    }

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    document.querySelectorAll('.view-panel').forEach((panel) => {
      panel.classList.remove('active');
    });

    const targetPanel = document.getElementById(`view-${viewName}`);
    if (targetPanel) {
      targetPanel.classList.add('active');
    }

    AppRouter.closeSidebar();

    if (viewName === 'dashboard') {
      AppState.currentFolderId = null;
      FolderController.renderDashboardFolders();
      FileController.renderRecentFiles();
      TodoController.renderTodayGoals();
    } else if (viewName === 'folder-detail') {
      AppState.currentFolderId = params.folderId;
      FolderController.renderFolderDetail(params.folderId);
    } else if (viewName === 'favourites') {
      FileController.renderFavourites();
    } else if (viewName === 'todos') {
      TodoController.renderFullTodoList();
    } else if (viewName === 'settings') {
      SettingsController.renderSettingsStats();
    }
  }
}

let restoringTransientHistory = false;

window.addEventListener('popstate', (e) => {
  if (restoringTransientHistory) {
    restoringTransientHistory = false;
    return;
  }

  const state = e.state;
  const openModal = document.querySelector('.modal-overlay:not(.hidden)');

  if (openModal) {
    if (openModal.id === 'modal-confirm' && ModalHelper.currentCleanup) {
      ModalHelper.currentCleanup();
    }
    openModal.classList.add('hidden');
    restoringTransientHistory = true;
    try {
      history.forward();
    } catch (_) {}
    return;
  }

  const sidebar = document.getElementById('sidebar');
  if (sidebar?.classList.contains('open')) {
    AppRouter.closeSidebar();
    restoringTransientHistory = true;
    try {
      history.forward();
    } catch (_) {}
    return;
  }

  if (state && state.tabId) {
    const tabExists = TabController.tabs.some(t => t.id === state.tabId);
    if (tabExists) {
      TabController.activateTab(state.tabId);
      return;
    }
  }

  if (TabController.activeTabId !== 'main') {
    TabController.activateTab('main');
  }

  if (state && state.view) {
    AppRouter.renderView(state.view, state.params || {}, false);
  } else {
    AppRouter.renderView('dashboard', {}, false);
  }
});

class FolderController {
  static init() {
    const addFolderBtn = document.getElementById('btn-open-add-folder');
    const addFolderModal = document.getElementById('modal-add-folder');
    const addFolderForm = document.getElementById('form-add-folder');
    const renameFolderBtn = document.getElementById('btn-rename-current-folder');
    const renameFolderModal = document.getElementById('modal-rename-folder');
    const renameFolderForm = document.getElementById('form-rename-folder');
    const listViewBtn = document.getElementById('folder-view-list-btn');
    const blockViewBtn = document.getElementById('folder-view-block-btn');

    addFolderBtn?.addEventListener('click', () => {
      document.getElementById('input-folder-name').value = '';
      addFolderModal.classList.remove('hidden');
    });

    addFolderForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const folderName = document.getElementById('input-folder-name').value.trim();
      const selectedColor = document.querySelector('input[name="folder-color"]:checked')?.value || 'blue';
      if (!folderName) return;

      const newFolder = {
        id: 'f_' + Date.now(),
        name: folderName,
        color: selectedColor,
        createdAt: Date.now()
      };

      await storage.saveFolder(newFolder);
      addFolderModal.classList.add('hidden');
      FolderController.renderDashboardFolders();
    });

    const setFolderView = async (view) => {
      await storage.setSetting('folderView', view);
      FolderController.renderDashboardFolders();
    };

    listViewBtn?.addEventListener('click', () => setFolderView('list'));
    blockViewBtn?.addEventListener('click', () => setFolderView('block'));

    renameFolderBtn?.addEventListener('click', async () => {
      if (!AppState.currentFolderId) return;
      const folder = await storage.getFolderById(AppState.currentFolderId);
      if (!folder) return;
      document.getElementById('input-rename-folder').value = folder.name;
      renameFolderModal.classList.remove('hidden');
    });

    renameFolderForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!AppState.currentFolderId) return;
      const newName = document.getElementById('input-rename-folder').value.trim();
      if (!newName) return;

      await storage.renameFolder(AppState.currentFolderId, newName);
      renameFolderModal.classList.add('hidden');
      await FolderController.renderFolderDetail(AppState.currentFolderId);
      FolderController.renderDashboardFolders();
    });

    document.getElementById('btn-delete-current-folder')?.addEventListener('click', () => {
      if (!AppState.currentFolderId) return;
      ModalHelper.confirm(
        'Delete Folder',
        'Are you sure? This will delete this folder and all stored files within it.',
        async () => {
          const folderId = AppState.currentFolderId;
          TabController.closeTabsForFolder(folderId);
          await storage.deleteFolder(folderId);
          history.back();
        }
      );
    });
  }

  static getColorHex(colorName) {
    const colorMap = {
      blue: '#3B82F6',
      green: '#10B981',
      yellow: '#F59E0B',
      red: '#EF4444',
      purple: '#8B5CF6',
      orange: '#F97316',
      gray: '#6B7280'
    };
    return colorMap[colorName] || '#3B82F6';
  }

  static async renderDashboardFolders() {
    const folders = await storage.getAllFolders();
    const folderView = await storage.getSetting('folderView', 'block');
    const emptyState = document.getElementById('empty-state-folders');
    const folderList = document.getElementById('dashboard-folders-list');

    folderList.classList.toggle('folder-list-view', folderView === 'list');
    document.getElementById('folder-view-list-btn')?.classList.toggle('active', folderView === 'list');
    document.getElementById('folder-view-block-btn')?.classList.toggle('active', folderView !== 'list');

    if (!folders || folders.length === 0) {
      emptyState.classList.remove('hidden');
      folderList.classList.add('hidden');
      folderList.innerHTML = '';
      return;
    }

    emptyState.classList.add('hidden');
    folderList.classList.remove('hidden');
    folderList.innerHTML = '';

    for (const folder of folders) {
      const files = await storage.getFilesByFolder(folder.id);
      const hex = FolderController.getColorHex(folder.color);
      const card = document.createElement('div');
      card.className = `folder-card-item ${folderView === 'list' ? 'folder-list-item' : ''}`;
      card.innerHTML = `
        <div class="folder-color-icon" style="color: ${hex}">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
        </div>
        <div class="folder-name-label">${escapeHtml(folder.name)}</div>
        <div class="folder-count-label">${files.length} ${files.length === 1 ? 'file' : 'files'}</div>
      `;
      card.addEventListener('click', () => {
        AppRouter.renderView('folder-detail', { folderId: folder.id }, true);
      });
      folderList.appendChild(card);
    }
  }

  static async renderFolderDetail(folderId) {
    const folder = await storage.getFolderById(folderId);
    if (!folder) {
      AppState.currentFolderId = null;
      AppRouter.renderView('dashboard', {}, false);
      return;
    }

    document.getElementById('current-folder-name').textContent = folder.name;
    document.getElementById('current-folder-color').style.backgroundColor = FolderController.getColorHex(folder.color);
    FileController.renderFolderFiles(folderId);
  }
}

class FileController {
  static init() {
    const btnPdf = document.getElementById('btn-upload-pdf');
    const btnPhoto = document.getElementById('btn-upload-photo');
    const pdfInput = document.getElementById('pdf-file-input');
    const photoInput = document.getElementById('photo-file-input');

    if (pdfInput) pdfInput.multiple = true;
    if (photoInput) photoInput.multiple = true;

    btnPdf?.addEventListener('click', () => pdfInput.click());
    btnPhoto?.addEventListener('click', () => photoInput.click());

    pdfInput?.addEventListener('change', (e) => FileController.handleFileUpload(e, 'pdf'));
    photoInput?.addEventListener('change', (e) => FileController.handleFileUpload(e, 'photo'));

    const clearRecentsBtn = document.getElementById('btn-clear-recents');
    clearRecentsBtn?.addEventListener('click', () => {
      ModalHelper.confirm(
        'Clear Recent History',
        'Clear your recently opened files history? All files will remain safe in their folders.',
        async () => {
          await storage.clearRecentFiles();
          FileController.renderRecentFiles();
        }
      );
    });
  }

  static formatDate(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  static async handleFileUpload(e, kind) {
    const files = Array.from(e.target.files || []);
    if (!files.length || !AppState.currentFolderId) return;

    const currentFolder = await storage.getFolderById(AppState.currentFolderId);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileRecord = {
        id: 'doc_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substr(2, 4),
        name: file.name,
        type: kind === 'pdf' ? 'pdf' : 'photo',
        mimeType: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg'),
        size: file.size,
        folderId: AppState.currentFolderId,
        folderName: currentFolder ? currentFolder.name : 'Unknown',
        blob: file,
        favorite: false,
        createdAt: Date.now() + i,
        lastOpened: 0,
        lastPage: 1,
        lastZoom: 100
      };

      await storage.saveFile(fileRecord);
    }

    e.target.value = '';
    FileController.renderFolderFiles(AppState.currentFolderId);
  }

  static async renderFolderFiles(folderId) {
    const files = await storage.getFilesByFolder(folderId);
    const emptyState = document.getElementById('empty-state-folder-files');
    const container = document.getElementById('folder-files-list');

    if (!files || files.length === 0) {
      emptyState.classList.remove('hidden');
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    emptyState.classList.add('hidden');
    container.classList.remove('hidden');
    container.innerHTML = '';

    files.forEach((file) => {
      const isPdf = file.type === 'pdf';
      const row = document.createElement('div');
      row.className = 'file-row-item';
      row.innerHTML = `
        <div class="file-row-left">
          <span class="file-badge ${isPdf ? 'pdf-badge' : 'img-badge'}">${isPdf ? 'PDF' : 'IMG'}</span>
          <div class="file-row-info">
            <span class="file-row-name">${escapeHtml(file.name)}</span>
            <span class="file-row-date">Added ${FileController.formatDate(file.createdAt)}</span>
          </div>
        </div>
        <div class="file-row-actions">
          <button class="icon-btn ${file.favorite ? 'star-active' : ''}" title="${file.favorite ? 'Remove from Favourites' : 'Add to Favourites'}" data-fav-id="${file.id}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="${file.favorite ? '#F59E0B' : 'none'}" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
          <button class="btn btn-primary btn-sm" data-open-id="${file.id}">Open</button>
          <button class="icon-btn" title="Delete" data-delete-id="${file.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;

      row.querySelector(`[data-fav-id="${file.id}"]`).addEventListener('click', async (e) => {
        e.stopPropagation();
        const newFavorite = file.favorite !== true;
        await storage.updateFileMetadata(file.id, { favorite: newFavorite });
        file.favorite = newFavorite;
        await FileController.renderFolderFiles(folderId);
      });

      row.querySelector(`[data-open-id="${file.id}"]`).addEventListener('click', () => {
        FileController.openFile(file.id);
      });

      row.querySelector(`[data-delete-id="${file.id}"]`).addEventListener('click', () => {
        ModalHelper.confirm(
          'Delete File',
          `Are you sure you want to delete "${file.name}"?`,
          async () => {
            await storage.deleteFile(file.id);
            TabController.closeTabsForFile(file.id);
            await FileController.renderFolderFiles(folderId);
            await FileController.renderFavourites();
          }
        );
      });

      container.appendChild(row);
    });
  }

  static async openFile(fileId) {
    await TabController.openFileTab(fileId);
  }

  static async renderRecentFiles() {
    const recents = await storage.getRecentFiles(3);
    const emptyState = document.getElementById('empty-state-recent');
    const list = document.getElementById('dashboard-recent-list');

    if (!recents || recents.length === 0) {
      emptyState.classList.remove('hidden');
      list.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    emptyState.classList.add('hidden');
    list.classList.remove('hidden');
    list.innerHTML = '';

    recents.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      const isPdf = file.type === 'pdf';
      item.innerHTML = `
        <div class="recent-left">
          <span class="file-badge ${isPdf ? 'pdf-badge' : 'img-badge'}">${isPdf ? 'PDF' : 'IMG'}</span>
          <div class="recent-info">
            <div class="recent-filename">${escapeHtml(file.name)}</div>
            <div class="recent-meta">${escapeHtml(file.folderName || 'Folder')} · Page ${file.lastPage || 1}</div>
          </div>
        </div>
        <button class="btn btn-light btn-sm recent-open-btn">Open</button>
      `;

      item.addEventListener('click', () => FileController.openFile(file.id));
      list.appendChild(item);
    });
  }

  static async renderFavourites() {
    const favourites = await storage.getFavoriteFiles();
    const emptyState = document.getElementById('empty-state-favourites');
    const container = document.getElementById('favourites-list');

    if (!favourites || favourites.length === 0) {
      emptyState.classList.remove('hidden');
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    emptyState.classList.add('hidden');
    container.classList.remove('hidden');
    container.innerHTML = '';

    favourites.forEach((file) => {
      const isPdf = file.type === 'pdf';
      const row = document.createElement('div');
      row.className = 'file-row-item';
      row.innerHTML = `
        <div class="file-row-left">
          <span class="file-badge ${isPdf ? 'pdf-badge' : 'img-badge'}">${isPdf ? 'PDF' : 'IMG'}</span>
          <div class="file-row-info">
            <span class="file-row-name">${escapeHtml(file.name)}</span>
            <span class="file-row-date">Folder: ${escapeHtml(file.folderName || 'General')}</span>
          </div>
        </div>
        <div class="file-row-actions">
          <button class="icon-btn star-active" title="Remove from Favourites" data-fav-id="${file.id}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#F59E0B" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
          <button class="btn btn-primary btn-sm" data-open-id="${file.id}">Open</button>
        </div>
      `;

      row.querySelector(`[data-fav-id="${file.id}"]`).addEventListener('click', async (e) => {
        e.stopPropagation();
        await storage.updateFileMetadata(file.id, { favorite: false });
        await FileController.renderFavourites();

        if (AppState.currentView === 'folder-detail' && AppState.currentFolderId === file.folderId) {
          await FileController.renderFolderFiles(file.folderId);
        }
      });

      row.querySelector(`[data-open-id="${file.id}"]`).addEventListener('click', () => {
        FileController.openFile(file.id);
      });

      container.appendChild(row);
    });
  }
}

class TodoController {
  static getTodayDateStr() {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  static init() {
    const openCreateBtn1 = document.getElementById('btn-open-create-todo');
    const openCreateBtn2 = document.getElementById('btn-open-create-todo-alt');
    const todoModal = document.getElementById('modal-create-todo');
    const todoForm = document.getElementById('form-create-todo');

    const openModalHandler = () => {
      document.getElementById('input-todo-edit-id').value = '';
      document.getElementById('input-todo-task').value = '';
      document.getElementById('input-todo-priority').value = 'normal';
      document.getElementById('input-todo-date').value = TodoController.getTodayDateStr();
      todoModal.classList.remove('hidden');
    };

    openCreateBtn1?.addEventListener('click', openModalHandler);
    openCreateBtn2?.addEventListener('click', openModalHandler);

    todoForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const editId = document.getElementById('input-todo-edit-id').value;
      const title = document.getElementById('input-todo-task').value.trim();
      const priority = document.getElementById('input-todo-priority').value;
      const dateStr = document.getElementById('input-todo-date').value || TodoController.getTodayDateStr();

      if (!title) return;

      if (editId) {
        const all = await storage.getAllTodos();
        const existing = all.find((t) => t.id === editId);
        if (existing) {
          existing.title = title;
          existing.priority = priority;
          existing.dateStr = dateStr;
          await storage.saveTodo(existing);
        }
      } else {
        const newTodo = {
          id: 'todo_' + Date.now(),
          title: title,
          priority: priority,
          dateStr: dateStr,
          completed: false,
          createdAt: Date.now()
        };
        await storage.saveTodo(newTodo);
      }

      todoModal.classList.add('hidden');
      TodoController.renderTodayGoals();

      if (AppState.currentView === 'todos') {
        TodoController.renderFullTodoList();
      }
    });

    document.querySelectorAll('[data-todo-filter]').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[data-todo-filter]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        AppState.activeFilter = tab.dataset.todoFilter;
        TodoController.renderFullTodoList();
      });
    });
  }

  static async renderTodayGoals() {
    const todayStr = TodoController.getTodayDateStr();
    const goals = await storage.getTodosByDate(todayStr);
    const emptyState = document.getElementById('empty-state-goals');
    const goalsList = document.getElementById('dashboard-goals-list');

    if (!goals || goals.length === 0) {
      emptyState.classList.remove('hidden');
      goalsList.classList.add('hidden');
      goalsList.innerHTML = '';
      return;
    }

    emptyState.classList.add('hidden');
    goalsList.classList.remove('hidden');
    goalsList.innerHTML = '';

    goals.forEach((todo) => {
      const li = document.createElement('li');
      li.className = `todo-item ${todo.completed ? 'completed' : ''}`;
      li.innerHTML = `
        <div class="todo-left">
          <input type="checkbox" class="todo-checkbox" ${todo.completed ? 'checked' : ''} />
          <span class="todo-text">${escapeHtml(todo.title)}</span>
          <span class="todo-badge todo-badge-${todo.priority}">${todo.priority}</span>
        </div>
        <div class="todo-actions">
          <button class="icon-btn" title="Delete" data-del="${todo.id}">&times;</button>
        </div>
      `;

      li.querySelector('.todo-checkbox').addEventListener('change', async (e) => {
        todo.completed = e.target.checked;
        await storage.saveTodo(todo);
        TodoController.renderTodayGoals();
      });

      li.querySelector('[data-del]').addEventListener('click', async () => {
        await storage.deleteTodo(todo.id);
        TodoController.renderTodayGoals();
      });

      goalsList.appendChild(li);
    });
  }

  static async renderFullTodoList() {
    let todos = await storage.getAllTodos();
    const todayStr = TodoController.getTodayDateStr();

    if (AppState.activeFilter === 'today') {
      todos = todos.filter((t) => t.dateStr === todayStr);
    } else if (AppState.activeFilter === 'completed') {
      todos = todos.filter((t) => t.completed === true);
    }

    const emptyState = document.getElementById('empty-state-all-todos');
    const todoUl = document.getElementById('all-todos-list');

    if (!todos || todos.length === 0) {
      emptyState.classList.remove('hidden');
      todoUl.classList.add('hidden');
      todoUl.innerHTML = '';
      return;
    }

    emptyState.classList.add('hidden');
    todoUl.classList.remove('hidden');
    todoUl.innerHTML = '';

    todos.forEach((todo) => {
      const li = document.createElement('li');
      li.className = `todo-item ${todo.completed ? 'completed' : ''}`;
      li.innerHTML = `
        <div class="todo-left">
          <input type="checkbox" class="todo-checkbox" ${todo.completed ? 'checked' : ''} />
          <span class="todo-text">${escapeHtml(todo.title)}</span>
          <span class="todo-badge todo-badge-${todo.priority}">${todo.priority}</span>
          <span class="recent-meta">(${todo.dateStr})</span>
        </div>
        <div class="todo-actions">
          <button class="icon-btn" title="Delete" data-del="${todo.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;

      li.querySelector('.todo-checkbox').addEventListener('change', async (e) => {
        todo.completed = e.target.checked;
        await storage.saveTodo(todo);
        TodoController.renderFullTodoList();
      });

      li.querySelector('[data-del]').addEventListener('click', async () => {
        await storage.deleteTodo(todo.id);
        TodoController.renderFullTodoList();
      });

      todoUl.appendChild(li);
    });
  }
}

class SearchController {
  static searchToken = 0;

  static init() {
    const input = document.getElementById('global-search-input');
    const clearBtn = document.getElementById('search-clear-btn');
    const dropdown = document.getElementById('search-results-dropdown');

    input?.addEventListener('input', async () => {
      const query = input.value.trim().toLowerCase();
      if (query.length > 0) {
        clearBtn.classList.remove('hidden');
        await SearchController.search(query);
      } else {
        SearchController.searchToken++;
        clearBtn.classList.add('hidden');
        dropdown.classList.add('hidden');
      }
    });

    clearBtn?.addEventListener('click', () => {
      SearchController.searchToken++;
      input.value = '';
      clearBtn.classList.add('hidden');
      dropdown.classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!input?.contains(e.target) && !dropdown?.contains(e.target)) {
        dropdown?.classList.add('hidden');
      }
    });
  }

  static async search(query) {
    const token = ++SearchController.searchToken;
    const dropdown = document.getElementById('search-results-dropdown');
    dropdown.innerHTML = '';

    const [folders, files, todos] = await Promise.all([
      storage.getAllFolders(),
      storage.getAllFiles(),
      storage.getAllTodos()
    ]);

    if (token !== SearchController.searchToken) return;

    const matchedFolders = folders.filter((f) => f.name.toLowerCase().includes(query));
    const matchedFiles = files.filter((f) => f.name.toLowerCase().includes(query));
    const matchedTodos = todos.filter((t) => t.title.toLowerCase().includes(query));

    if (matchedFolders.length === 0 && matchedFiles.length === 0 && matchedTodos.length === 0) {
      dropdown.innerHTML = `<div class="search-result-item" style="color: var(--text-muted);">No results found</div>`;
      dropdown.classList.remove('hidden');
      return;
    }

    matchedFolders.forEach((f) => {
      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.innerHTML = `<span>📁 ${escapeHtml(f.name)}</span><span class="search-result-type">Folder</span>`;
      div.addEventListener('click', () => {
        dropdown.classList.add('hidden');
        AppRouter.renderView('folder-detail', { folderId: f.id }, true);
      });
      dropdown.appendChild(div);
    });

    matchedFiles.forEach((f) => {
      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.innerHTML = `<span>${f.type === 'pdf' ? '📄' : '🖼️'} ${escapeHtml(f.name)}</span><span class="search-result-type">${f.type}</span>`;
      div.addEventListener('click', () => {
        dropdown.classList.add('hidden');
        FileController.openFile(f.id);
      });
      dropdown.appendChild(div);
    });

    matchedTodos.forEach((t) => {
      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.innerHTML = `<span>☑️ ${escapeHtml(t.title)}</span><span class="search-result-type">Todo</span>`;
      div.addEventListener('click', () => {
        dropdown.classList.add('hidden');
        AppRouter.renderView('todos', {}, true);
      });
      dropdown.appendChild(div);
    });

    dropdown.classList.remove('hidden');
  }
}

class GreetingController {
  static async init() {
    const greeting = document.getElementById('dashboard-greeting');
    const editBtn = document.getElementById('btn-edit-greeting');
    const modal = document.getElementById('modal-edit-greeting');
    const form = document.getElementById('form-edit-greeting');
    const input = document.getElementById('input-greeting');
    const count = document.getElementById('greeting-word-count');

    const savedGreeting = await storage.getSetting('dashboardGreeting', 'Hello, Junayed');
    greeting.textContent = savedGreeting;

    const updateCount = () => {
      const words = input.value.trim() ? input.value.trim().split(/\s+/) : [];
      count.textContent = `${words.length} / 25 words`;
      if (words.length > 25) {
        input.value = words.slice(0, 25).join(' ');
        count.textContent = '25 / 25 words';
      }
    };

    editBtn?.addEventListener('click', () => {
      input.value = greeting.textContent;
      updateCount();
      modal.classList.remove('hidden');
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);
    });

    input?.addEventListener('input', updateCount);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const words = input.value.trim() ? input.value.trim().split(/\s+/) : [];
      if (words.length === 0) return;

      const value = (words.length > 25 ? words.slice(0, 25).join(' ') : input.value).trim();
      await storage.setSetting('dashboardGreeting', value);
      greeting.textContent = value;
      modal.classList.add('hidden');
    });
  }
}

class SettingsController {
  static async init() {
    const lightBtn = document.getElementById('theme-light-btn');
    const darkBtn = document.getElementById('theme-dark-btn');
    const clearAllBtn = document.getElementById('btn-clear-all-data');

    const savedTheme = await storage.getSetting('theme', 'light');
    SettingsController.applyTheme(savedTheme);

    lightBtn?.addEventListener('click', () => SettingsController.setTheme('light'));
    darkBtn?.addEventListener('click', () => SettingsController.setTheme('dark'));

    clearAllBtn?.addEventListener('click', () => {
      ModalHelper.confirm(
        'Reset Application Data',
        'Are you sure? This will permanently delete all Study Hub data.',
        async () => {
          await storage.clearAllData();
          window.location.reload();
        }
      );
    });
  }

  static applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    document.getElementById('theme-light-btn')?.classList.toggle('active', theme === 'light');
    document.getElementById('theme-dark-btn')?.classList.toggle('active', theme === 'dark');
  }

  static async setTheme(theme) {
    SettingsController.applyTheme(theme);
    await storage.setSetting('theme', theme);
  }

  static async renderSettingsStats() {
    const [folders, files, todos] = await Promise.all([
      storage.getAllFolders(),
      storage.getAllFiles(),
      storage.getAllTodos()
    ]);

    document.getElementById('stat-folders-count').textContent = folders.length;
    document.getElementById('stat-files-count').textContent = files.length;
    document.getElementById('stat-todos-count').textContent = todos.length;

    const sizeElem = document.getElementById('stat-storage-size');
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const bytes = estimate.usage || 0;
      sizeElem.textContent = (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      sizeElem.textContent = 'Available';
    }
  }
}

class ModalHelper {
  static currentCleanup = null;

  static init() {
    document.querySelectorAll('[data-modal-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.modalClose;
        const modal = document.getElementById(modalId);
        if (modal?.id === 'modal-confirm' && ModalHelper.currentCleanup) {
          ModalHelper.currentCleanup();
        }
        if (modal) modal.classList.add('hidden');
      });
    });
  }

  static confirm(title, message, onConfirm) {
    const modal = document.getElementById('modal-confirm');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    if (!modal || !okBtn || !cancelBtn) return;
    if (ModalHelper.currentCleanup) ModalHelper.currentCleanup();

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    modal.classList.remove('hidden');

    let handleConfirm;
    let handleCancel;

    const cleanup = () => {
      okBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
      if (ModalHelper.currentCleanup === cleanup) {
        ModalHelper.currentCleanup = null;
      }
    };

    handleConfirm = () => {
      cleanup();
      modal.classList.add('hidden');
      onConfirm();
    };

    handleCancel = () => {
      cleanup();
      modal.classList.add('hidden');
    };

    ModalHelper.currentCleanup = cleanup;
    okBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(
    /[&<>"']/g,
    (m) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[m])
  );
}

class ViewModeController {
  static async init() {
    const toggleBtn = document.getElementById('btn-toggle-view-mode');
    if (!toggleBtn) return;

    const savedMode = (await storage.getSetting('appViewMode', 'tab')) || 'tab';
    ViewModeController.applyMode(savedMode);

    toggleBtn.addEventListener('click', async () => {
      if (toggleBtn.disabled || toggleBtn.classList.contains('is-locked')) return;
      const isNormal = document.body.classList.contains('normal-view');
      const newMode = isNormal ? 'tab' : 'normal';
      ViewModeController.applyMode(newMode);
      await storage.setSetting('appViewMode', newMode);
    });

    ViewModeController.updateLockState();
  }

  static applyMode(mode) {
    const label = document.getElementById('view-mode-label');
    if (mode === 'normal') {
      document.body.classList.add('normal-view');
      if (label) label.textContent = 'Tab View';
    } else {
      document.body.classList.remove('normal-view');
      if (label) label.textContent = 'Normal View';
    }
    ViewModeController.updateLockState();
  }

  static updateLockState() {
    const toggleBtn = document.getElementById('btn-toggle-view-mode');
    if (!toggleBtn) return;

    const hasOpenFiles = TabController.tabs && TabController.tabs.length > 0;
    const isTabMode = !document.body.classList.contains('normal-view');

    if (isTabMode && hasOpenFiles) {
      toggleBtn.disabled = true;
      toggleBtn.classList.add('is-locked');
      toggleBtn.title = 'Close all open document tabs first to switch to Normal View';
    } else {
      toggleBtn.disabled = false;
      toggleBtn.classList.remove('is-locked');
      toggleBtn.title = 'Toggle Tab/Normal view';
    }
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await storage.init();
    await ViewModeController.init();
    enableTabStripMouseDrag();
    TabController.init();
    AppRouter.init();
    FolderController.init();
    FileController.init();
    TodoController.init();
    SearchController.init();
    ModalHelper.init();
    await GreetingController.init();
    await SettingsController.init();

    if (!history.state) {
      try {
        history.replaceState({ view: 'dashboard' }, '', '#dashboard');
      } catch (_) {}
    }

    AppRouter.renderView('dashboard', {}, false);
  } catch (err) {
    console.error('Bootstrap error:', err);
  }
});