/**
 * GS1 EXPIRY TRACKER v10.0.0
 * FAST - Instant scan results
 * 
 * FIXES:
 * - RMS/Alshaya Code proper mapping
 * - Instant data display after scan (no delay)
 * - Scan result widget shows all details
 * - Removed OCR (not reliable) - use manual entry
 * 
 * By VYSAKH
 */

const CONFIG = {
  DB_NAME: 'GS1TrackerDB',
  DB_VERSION: 8,
  EXPIRY_DAYS: 90,
  VERSION: '10.2.0',
  STORE_NAME: 'OASIS PHARMACY'
};

// App State
const App = {
  db: null,
  master: new Map(),        // barcode -> full product
  masterRMS: new Map(),     // RMS -> product
  masterAlshaya: new Map(), // Alshaya code -> product
  settings: { apiEnabled: false, hapticEnabled: true, darkMode: false, storeName: CONFIG.STORE_NAME },
  scanner: { active: false, instance: null },
  pendingItem: null,
  scanMode: 'normal',
  filter: 'all',
  search: '',
  editingId: null,
  suppliers: [],
  categories: [
    { id: 'medicine', name: 'Medicine', icon: '💊', color: '#2563EB' },
    { id: 'cosmetics', name: 'Cosmetics', icon: '🧴', color: '#EC4899' },
    { id: 'vitamins', name: 'Vitamins', icon: '💪', color: '#F59E0B' },
    { id: 'baby', name: 'Baby', icon: '👶', color: '#06B6D4' },
    { id: 'medical', name: 'Medical', icon: '🩺', color: '#10B981' },
    { id: 'other', name: 'Other', icon: '📦', color: '#6B7280' }
  ]
};

// ============================================
// GS1 PARSER - OPTIMIZED
// ============================================
const GS1 = {
  parse(code) {
    const r = { raw: code || '', gtin: '', gtin13: '', expiry: '', expiryISO: '', expiryDisplay: '', batch: '', serial: '', qty: 1, isGS1: false };
    if (!code) return r;
    
    code = code.trim().replace(/[\r\n\t]/g, '');
    
    // Remove prefixes
    [']C1', ']e0', ']E0', ']d2', ']Q3'].forEach(p => { if (code.startsWith(p)) code = code.slice(p.length); });
    
    // Normalize FNC1
    code = code.replace(/[\x1d\x1e\x1c~]/g, '\x1d').replace(/\[FNC1\]|<GS>|\{GS\}/gi, '\x1d');
    
    // Check if GS1
    if (code.includes('\x1d') || /\(\d{2,4}\)/.test(code) || (/^(01|02|10|17|21)\d/.test(code) && code.length > 16)) {
      r.isGS1 = true;
      this.parseGS1(code, r);
    } else {
      // Simple barcode
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14) {
        r.gtin = digits.padStart(14, '0');
        r.gtin13 = digits.slice(-13).padStart(13, '0');
      }
    }
    
    return r;
  },

  parseGS1(code, r) {
    // Parentheses format
    if (code.includes('(')) {
      let m = code.match(/\(01\)(\d{14})/); if (m) { r.gtin = m[1]; r.gtin13 = m[1].slice(-13); }
      m = code.match(/\(17\)(\d{6})/) || code.match(/\(15\)(\d{6})/); if (m) this.parseDate(m[1], r);
      m = code.match(/\(10\)([^\(]+)/); if (m) r.batch = m[1].trim().slice(0, 20);
      m = code.match(/\(21\)([^\(]+)/); if (m) r.serial = m[1].trim().slice(0, 20);
      return;
    }
    
    // Raw AI format
    let pos = 0, len = code.length;
    while (pos < len) {
      if (code[pos] === '\x1d') { pos++; continue; }
      const ai = code.slice(pos, pos + 2);
      
      if (ai === '01' || ai === '02') {
        r.gtin = code.slice(pos + 2, pos + 16);
        r.gtin13 = r.gtin.slice(-13);
        pos += 16;
      } else if (ai === '17' || ai === '15') {
        this.parseDate(code.slice(pos + 2, pos + 8), r);
        pos += 8;
      } else if (ai === '10') {
        pos += 2;
        let batch = '';
        while (pos < len && code[pos] !== '\x1d') batch += code[pos++];
        r.batch = batch.slice(0, 20);
      } else if (ai === '21') {
        pos += 2;
        while (pos < len && code[pos] !== '\x1d') pos++;
      } else if (ai === '11' || ai === '12' || ai === '13') {
        pos += 8;
      } else {
        pos++;
      }
    }
  },

  parseDate(yymmdd, r) {
    if (!yymmdd || yymmdd.length !== 6) return;
    const yy = parseInt(yymmdd.slice(0, 2)), mm = parseInt(yymmdd.slice(2, 4));
    let dd = parseInt(yymmdd.slice(4, 6));
    if (isNaN(yy) || isNaN(mm) || isNaN(dd) || mm < 1 || mm > 12) return;
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    if (dd === 0) dd = new Date(year, mm, 0).getDate();
    r.expiry = yymmdd;
    r.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    r.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
  },

  getStatus(iso) {
    if (!iso) return 'unknown';
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(iso); exp.setHours(0,0,0,0);
    const days = Math.floor((exp - today) / 86400000);
    return days < 0 ? 'expired' : days <= CONFIG.EXPIRY_DAYS ? 'expiring' : 'ok';
  },

  getDays(iso) {
    if (!iso) return Infinity;
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(iso); exp.setHours(0,0,0,0);
    return Math.floor((exp - today) / 86400000);
  }
};

// ============================================
// MATCHER - FAST LOOKUP
// ============================================
const Matcher = {
  build(data) {
    App.master.clear();
    App.masterRMS.clear();
    App.masterAlshaya.clear();
    
    for (const item of data) {
      const bc = String(item.barcode || '').replace(/\D/g, '');
      if (bc.length < 8) continue;
      
      const product = {
        barcode: bc,
        barcode13: bc.slice(-13).padStart(13, '0'),
        name: item.name || item.description || '',
        rms: String(item.rms || item.rmsId || item['rms id'] || item['RMS ID'] || '').trim(),
        alshayaCode: String(item.alshayaCode || item['alshaya code'] || item['ALSHAYA CODE'] || '').trim(),
        newAlshayaCode: String(item.newAlshayaCode || item['new alshaya code'] || item['NEW ALSHAYA CODE'] || '').trim(),
        brand: item.brand || item.BRAND || '',
        supplier: item.supplier || item.supplierName || item['supplier name'] || item.SUPPLIER || item['SUPPLIER NAME'] || '',
        conceptGroup: item.conceptGroup || item['concept group'] || '',
        returnPolicy: item.returnPolicy || item['return policy'] || '',
        keyBrands: item.keyBrands || item['key brands'] || '',
        status: item.status || 'Active'
      };
      
      // Use newAlshayaCode as alshayaCode if alshayaCode is empty
      if (!product.alshayaCode && product.newAlshayaCode) {
        product.alshayaCode = product.newAlshayaCode;
      }
      
      // Index by multiple keys
      App.master.set(bc, product);
      App.master.set(bc.padStart(14, '0'), product);
      App.master.set(bc.slice(-13), product);
      App.master.set(bc.slice(-12), product);
      App.master.set(bc.slice(-8), product);
      
      // Index by RMS
      if (product.rms) {
        App.masterRMS.set(product.rms, product);
        App.masterRMS.set(product.rms.replace(/\D/g, ''), product);
      }
      
      // Index by Alshaya code
      if (product.alshayaCode) {
        App.masterAlshaya.set(product.alshayaCode, product);
        App.masterAlshaya.set(product.alshayaCode.replace(/[^A-Z0-9]/gi, ''), product);
      }
    }
    
    console.log(`✅ Indexed ${App.master.size} products`);
  },

  find(code) {
    if (!code) return null;
    const clean = code.replace(/\D/g, '');
    
    // Try direct match
    if (App.master.has(clean)) return { ...App.master.get(clean), matchType: 'BARCODE' };
    if (App.master.has(clean.padStart(14, '0'))) return { ...App.master.get(clean.padStart(14, '0')), matchType: 'GTIN14' };
    if (App.master.has(clean.slice(-13))) return { ...App.master.get(clean.slice(-13)), matchType: 'GTIN13' };
    if (App.master.has(clean.slice(-12))) return { ...App.master.get(clean.slice(-12)), matchType: 'GTIN12' };
    if (App.master.has(clean.slice(-8))) return { ...App.master.get(clean.slice(-8)), matchType: 'PARTIAL' };
    
    // Try RMS
    if (App.masterRMS.has(code)) return { ...App.masterRMS.get(code), matchType: 'RMS' };
    if (App.masterRMS.has(clean)) return { ...App.masterRMS.get(clean), matchType: 'RMS' };
    
    // Try Alshaya
    if (App.masterAlshaya.has(code)) return { ...App.masterAlshaya.get(code), matchType: 'ALSHAYA' };
    
    return null;
  },
  
  // Add single product to all indexes (for new products)
  addProduct(item) {
    const bc = String(item.barcode || '').replace(/\D/g, '');
    if (bc.length < 8) return;
    
    const product = {
      barcode: bc,
      barcode13: bc.slice(-13).padStart(13, '0'),
      name: item.name || item.description || '',
      rms: String(item.rms || '').trim(),
      alshayaCode: String(item.alshayaCode || '').trim(),
      newAlshayaCode: String(item.newAlshayaCode || '').trim(),
      brand: item.brand || '',
      supplier: item.supplier || '',
      returnPolicy: item.returnPolicy || 'NO',
      notes: item.notes || '',
      status: item.status || 'Active'
    };
    
    // Index by multiple keys
    App.master.set(bc, product);
    App.master.set(bc.padStart(14, '0'), product);
    App.master.set(bc.slice(-13), product);
    App.master.set(bc.slice(-12), product);
    App.master.set(bc.slice(-8), product);
    
    // Index by RMS
    if (product.rms) {
      App.masterRMS.set(product.rms, product);
      App.masterRMS.set(product.rms.replace(/\D/g, ''), product);
    }
    
    // Index by Alshaya code
    if (product.alshayaCode) {
      App.masterAlshaya.set(product.alshayaCode, product);
    }
    
    console.log(`✅ Added product: ${product.name}`);
  }
};

// ============================================
// DATABASE
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { App.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'id', autoIncrement: true }).createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('master')) {
          db.createObjectStore('master', { keyPath: 'barcode' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  },

  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = App.db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      if (r?.onsuccess !== undefined) { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }
      else { t.oncomplete = () => resolve(r); t.onerror = () => reject(t.error); }
    });
  },

  addHistory: (item) => { item.timestamp = Date.now(); return DB.tx('history', 'readwrite', s => s.add(item)); },
  updateHistory: (item) => DB.tx('history', 'readwrite', s => s.put(item)),
  getHistory: (id) => DB.tx('history', 'readonly', s => s.get(id)),
  getAllHistory: () => DB.tx('history', 'readonly', s => s.getAll()),
  deleteHistory: (id) => DB.tx('history', 'readwrite', s => s.delete(id)),
  clearHistory: () => DB.tx('history', 'readwrite', s => s.clear()),
  addMaster: (item) => DB.tx('master', 'readwrite', s => s.put(item)),
  getAllMaster: () => DB.tx('master', 'readonly', s => s.getAll()),
  getMaster: (barcode) => DB.tx('master', 'readonly', s => s.get(barcode)),
  
  // Add new product to master
  addMasterProduct: (product) => DB.tx('master', 'readwrite', s => s.put(product)),
  
  // Update existing master product
  updateMasterProduct: (product) => DB.tx('master', 'readwrite', s => s.put(product)),
  
  // Delete master product
  deleteMasterProduct: (barcode) => DB.tx('master', 'readwrite', s => s.delete(barcode)),
  
  // Clear all master data
  clearMaster: () => DB.tx('master', 'readwrite', s => s.clear()),
  
  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const t = App.db.transaction('master', 'readwrite');
      const s = t.objectStore('master');
      let c = 0;
      for (const item of items) { if (item.barcode) { s.put(item); c++; } }
      t.oncomplete = () => resolve(c);
      t.onerror = () => reject(t.error);
    });
  },

  getSetting: async (key, def) => { try { const r = await DB.tx('settings', 'readonly', s => s.get(key)); return r?.value ?? def; } catch { return def; } },
  setSetting: (key, value) => DB.tx('settings', 'readwrite', s => s.put({ key, value }))
};

// ============================================
// SCANNER
// ============================================
const Scanner = {
  async toggle() { App.scanner.active ? await this.stop() : await this.start(); },

  async start() {
    try {
      if (!App.scanner.instance) App.scanner.instance = new Html5Qrcode('reader');
      await App.scanner.instance.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox: { width: 250, height: 150 } },
        code => this.onScan(code),
        () => {}
      );
      App.scanner.active = true;
      document.getElementById('scannerPlaceholder').classList.add('hidden');
      document.getElementById('viewfinder').classList.add('active');
      document.getElementById('btnScannerText').textContent = 'Stop';
      document.getElementById('btnScanner').classList.add('stop');
      haptic('medium');
    } catch (e) {
      toast('Camera error: ' + e.message, 'error');
    }
  },

  async stop() {
    try { if (App.scanner.instance && App.scanner.active) await App.scanner.instance.stop(); } catch {}
    App.scanner.active = false;
    document.getElementById('scannerPlaceholder')?.classList.remove('hidden');
    document.getElementById('viewfinder')?.classList.remove('active');
    document.getElementById('btnScannerText').textContent = 'Start Scanner';
    document.getElementById('btnScanner')?.classList.remove('stop');
  },

  async onScan(code) {
    await this.stop();
    haptic('success');
    
    if (App.scanMode === 'product' && App.pendingItem) {
      completeProductScan(code);
    } else {
      processBarcode(code);
    }
  }
};

// ============================================
// BARCODE PROCESSING - INSTANT
// ============================================
function processBarcode(code) {
  if (!code) return;
  code = code.trim();
  if (!code) return;
  
  console.log('📷 Scanned:', code);
  
  // Parse immediately
  const parsed = GS1.parse(code);
  console.log('📊 Parsed:', parsed);
  
  // Find product immediately
  let product = null;
  if (parsed.gtin) {
    product = Matcher.find(parsed.gtin);
  }
  if (!product && parsed.gtin13) {
    product = Matcher.find(parsed.gtin13);
  }
  if (!product) {
    product = Matcher.find(code);
  }
  
  // Show result widget IMMEDIATELY
  showScanResult(parsed, product);
  
  document.getElementById('manualInput').value = '';
}

function completeProductScan(code) {
  const parsed = GS1.parse(code);
  let product = Matcher.find(parsed.gtin || parsed.gtin13 || code);
  
  if (product) {
    // Merge with pending
    const item = {
      ...App.pendingItem,
      name: product.name,
      rms: product.rms,
      alshayaCode: product.alshayaCode,
      brand: product.brand,
      supplier: product.supplier,
      conceptGroup: product.conceptGroup,
      returnPolicy: product.returnPolicy,
      keyBrands: product.keyBrands,
      matchType: product.matchType
    };
    clearPending();
    showScanResult(item, product);
  } else {
    // Show manual entry
    clearPending();
    showScanResult(App.pendingItem, null);
  }
}

// ============================================
// SCAN RESULT WIDGET - INSTANT DISPLAY
// ============================================
function showScanResult(parsed, product) {
  let widget = document.getElementById('scanResultWidget');
  
  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'scanResultWidget';
    widget.className = 'scan-result-widget';
    document.body.appendChild(widget);
  }
  
  const found = product && product.name;
  const status = parsed.expiryISO ? GS1.getStatus(parsed.expiryISO) : 'unknown';
  const days = parsed.expiryISO ? GS1.getDays(parsed.expiryISO) : null;
  
  // Check if non-returnable
  const isNonReturnable = product?.returnPolicy?.toUpperCase() === 'YES' || 
                          product?.nonReturnable?.toUpperCase() === 'YES' ||
                          product?.returnPolicy?.toUpperCase() === 'NON-RETURNABLE';
  
  // Check for special notes
  const specialNotes = product?.notes || product?.specialNotes || product?.directions || '';
  
  let statusBadge = '';
  if (status === 'expired') statusBadge = '<span class="badge badge-expired" style="font-size:0.75rem;padding:4px 10px;">⚠️ EXPIRED</span>';
  else if (status === 'expiring') statusBadge = `<span class="badge badge-expiring" style="font-size:0.75rem;padding:4px 10px;">⏰ ${days} DAYS LEFT</span>`;
  else if (status === 'ok' && days !== null) statusBadge = `<span class="badge badge-ok" style="font-size:0.75rem;padding:4px 10px;">✓ ${days} DAYS</span>`;
  
  const barcodeDisplay = parsed.gtin13 || parsed.gtin?.slice(-13) || parsed.raw?.slice(0,14) || '-';
  
  widget.innerHTML = `
    <div class="srw-header ${found ? 'found' : 'notfound'}">
      <span class="srw-icon">${found ? '✅' : '⚠️'}</span>
      <span class="srw-title">${found ? 'PRODUCT FOUND' : 'NEW PRODUCT'}</span>
      <button class="srw-close" onclick="hideScanResult()">✕</button>
    </div>
    <div class="srw-body">
      
      <!-- NON-RETURNABLE WARNING -->
      ${isNonReturnable ? `
      <div style="background:#fee2e2;border:2px solid #DC2626;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;animation:pulse 1s ease-in-out 3;">
        <span style="font-size:1.5rem;">🚫</span>
        <div>
          <div style="font-size:0.9rem;font-weight:800;color:#DC2626;">NON-RETURNABLE PRODUCT</div>
          <div style="font-size:0.7rem;color:#991B1B;">This item cannot be returned</div>
        </div>
      </div>
      ` : ''}
      
      <!-- SPECIAL NOTES -->
      ${specialNotes ? `
      <div style="background:#fef3c7;border:1px solid #F59E0B;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
        <span style="font-size:1.2rem;">📝</span>
        <div>
          <div style="font-size:0.65rem;font-weight:700;color:#92400E;">SPECIAL NOTE</div>
          <div style="font-size:0.85rem;color:#78350F;margin-top:2px;">${escapeHtml(specialNotes)}</div>
        </div>
      </div>
      ` : ''}
      
      <!-- DESCRIPTION - EDITABLE FOR NEW PRODUCTS -->
      <div style="background:linear-gradient(135deg,#f0f9ff,#e0f2fe);padding:14px;border-radius:12px;margin-bottom:14px;border-left:4px solid ${found ? '#10B981' : '#F59E0B'};">
        <div style="font-size:0.6rem;font-weight:700;color:#64748B;letter-spacing:1px;margin-bottom:4px;">📦 DESCRIPTION ${!found ? '(Edit to add)' : ''}</div>
        ${!found ? `
        <input type="text" id="srwName" style="width:100%;font-size:1.1rem;font-weight:700;padding:8px 10px;border:2px solid #F59E0B;border-radius:8px;background:#fff;" 
               placeholder="Enter product name..." value="${escapeHtml(product?.name || '')}">
        ` : `
        <div style="font-size:1.25rem;font-weight:800;color:#1E293B;line-height:1.3;">${escapeHtml(product?.name || 'Unknown')}</div>
        `}
        ${statusBadge ? `<div style="margin-top:8px;">${statusBadge}</div>` : ''}
      </div>
      
      <!-- BRAND & SUPPLIER - EDITABLE FOR NEW -->
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <div style="flex:1;background:#fef3c7;padding:10px 12px;border-radius:10px;">
          <div style="font-size:0.55rem;font-weight:700;color:#92400E;letter-spacing:0.5px;">🏷️ BRAND</div>
          ${!found ? `
          <input type="text" id="srwBrand" style="width:100%;font-size:0.9rem;font-weight:600;padding:6px 8px;border:1px solid #FCD34D;border-radius:6px;background:#fff;margin-top:4px;" 
                 placeholder="Brand" value="${escapeHtml(product?.brand || '')}">
          ` : `
          <div style="font-size:0.95rem;font-weight:700;color:#78350F;margin-top:2px;">${escapeHtml(product?.brand || '-')}</div>
          `}
        </div>
        <div style="flex:1;background:#dbeafe;padding:10px 12px;border-radius:10px;">
          <div style="font-size:0.55rem;font-weight:700;color:#1E40AF;letter-spacing:0.5px;">🏢 SUPPLIER</div>
          ${!found ? `
          <input type="text" id="srwSupplier" style="width:100%;font-size:0.9rem;font-weight:600;padding:6px 8px;border:1px solid #93C5FD;border-radius:6px;background:#fff;margin-top:4px;" 
                 placeholder="Supplier" value="${escapeHtml(product?.supplier || '')}">
          ` : `
          <div style="font-size:0.95rem;font-weight:700;color:#1E3A8A;margin-top:2px;">${escapeHtml(product?.supplier || '-')}</div>
          `}
        </div>
      </div>
      
      <!-- CODES SECTION - EDITABLE FOR NEW -->
      <div style="background:#f8fafc;padding:12px;border-radius:10px;margin-bottom:10px;border:1px solid #e2e8f0;">
        <div style="font-size:0.6rem;font-weight:700;color:#64748B;letter-spacing:1px;margin-bottom:8px;">🔢 PRODUCT CODES</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div style="background:#fff;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
            <div style="font-size:0.5rem;color:#94A3B8;font-weight:600;">BARCODE</div>
            <div style="font-family:monospace;font-size:0.85rem;font-weight:700;color:#1E293B;">${barcodeDisplay}</div>
          </div>
          <div style="background:#fff;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
            <div style="font-size:0.5rem;color:#94A3B8;font-weight:600;">RMS ID</div>
            ${!found ? `
            <input type="text" id="srwRms" style="width:100%;font-family:monospace;font-size:0.8rem;padding:4px;border:1px solid #e2e8f0;border-radius:4px;" 
                   placeholder="RMS" value="${product?.rms || ''}">
            ` : `
            <div style="font-family:monospace;font-size:0.85rem;font-weight:700;color:#1E293B;">${product?.rms || '-'}</div>
            `}
          </div>
          <div style="background:#fff;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
            <div style="font-size:0.5rem;color:#94A3B8;font-weight:600;">ALSHAYA CODE</div>
            ${!found ? `
            <input type="text" id="srwAlshaya" style="width:100%;font-family:monospace;font-size:0.8rem;padding:4px;border:1px solid #e2e8f0;border-radius:4px;" 
                   placeholder="Alshaya Code" value="${product?.alshayaCode || ''}">
            ` : `
            <div style="font-family:monospace;font-size:0.85rem;font-weight:700;color:#1E293B;">${product?.alshayaCode || '-'}</div>
            `}
          </div>
          <div style="background:#fff;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
            <div style="font-size:0.5rem;color:#94A3B8;font-weight:600;">RETURN POLICY</div>
            ${!found ? `
            <select id="srwReturn" style="width:100%;font-size:0.8rem;padding:4px;border:1px solid #e2e8f0;border-radius:4px;">
              <option value="NO">Returnable</option>
              <option value="YES">Non-Returnable</option>
            </select>
            ` : `
            <div style="font-size:0.85rem;font-weight:700;color:${isNonReturnable ? '#DC2626' : '#059669'};">${isNonReturnable ? '🚫 No' : '✓ Yes'}</div>
            `}
          </div>
        </div>
      </div>
      
      <!-- EXPIRY & BATCH - ALWAYS EDITABLE WITH AUTO-MOVE -->
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px;margin-bottom:10px;">
        <div style="font-size:0.65rem;font-weight:700;color:#9A3412;margin-bottom:8px;">📅 EXPIRY & BATCH</div>
        <div style="display:flex;gap:8px;">
          <div style="flex:1;">
            <div style="font-size:0.5rem;color:#92400E;margin-bottom:2px;">EXPIRY (DDMMYY)</div>
            <input type="text" id="srwExpiryText" 
                   style="width:100%;font-family:monospace;font-size:1rem;font-weight:700;padding:10px;border:2px solid #FCD34D;border-radius:8px;text-align:center;background:#fff;" 
                   placeholder="DDMMYY" maxlength="6" inputmode="numeric"
                   value="${parsed.expiry || ''}"
                   oninput="handleExpiryInput(this)" onkeyup="autoMoveToBatch(this)">
            <input type="hidden" id="srwExpiry" value="${parsed.expiryISO || ''}">
          </div>
          <div style="flex:1;">
            <div style="font-size:0.5rem;color:#92400E;margin-bottom:2px;">BATCH NO</div>
            <input type="text" id="srwBatch" 
                   style="width:100%;font-family:monospace;font-size:1rem;font-weight:700;padding:10px;border:2px solid #FCD34D;border-radius:8px;text-align:center;background:#fff;" 
                   placeholder="BATCH" maxlength="20"
                   value="${parsed.batch || ''}"
                   onkeyup="autoMoveToQty(this)">
          </div>
        </div>
        <div id="expiryPreview" style="font-size:0.75rem;color:#065F46;margin-top:6px;text-align:center;display:none;"></div>
      </div>
      
      <!-- GS1 STATUS -->
      <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:${parsed.isGS1 ? '#d1fae5' : '#fef3c7'};border-radius:8px;margin-bottom:12px;justify-content:center;">
        <span style="font-size:0.9rem;">${parsed.isGS1 ? '✅' : '📝'}</span>
        <span style="font-size:0.75rem;font-weight:600;color:${parsed.isGS1 ? '#065F46' : '#92400E'};">${parsed.isGS1 ? 'Valid GS1 Barcode' : 'Manual Entry Mode'}</span>
      </div>
      
      <!-- QUANTITY -->
      <div style="background:#f1f5f9;padding:12px;border-radius:10px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;">
          <span style="font-weight:700;color:#475569;">QTY:</span>
          <button class="qty-btn" onclick="adjustSrwQty(-1)" style="width:40px;height:40px;font-size:1.4rem;border-radius:10px;">−</button>
          <input type="number" id="srwQty" value="1" min="1" 
                 style="width:70px;padding:10px;text-align:center;border:2px solid #CBD5E1;border-radius:10px;font-size:1.3rem;font-weight:700;">
          <button class="qty-btn" onclick="adjustSrwQty(1)" style="width:40px;height:40px;font-size:1.4rem;border-radius:10px;">+</button>
        </div>
      </div>
      
      <!-- ACTIONS -->
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${!found ? `
        <button class="btn" onclick="saveAsNewProduct()" style="background:#10B981;color:#fff;padding:14px;font-size:1rem;font-weight:700;border-radius:10px;border:none;width:100%;">
          ➕ ADD TO MASTER & SAVE
        </button>
        ` : `
        <button class="btn" onclick="saveScanResult()" style="background:#2563EB;color:#fff;padding:14px;font-size:1rem;font-weight:700;border-radius:10px;border:none;width:100%;">
          💾 SAVE TO HISTORY
        </button>
        `}
        <div style="display:flex;gap:8px;">
          ${found ? `<button class="btn" onclick="editProductMaster()" style="flex:1;background:#F59E0B;color:#fff;padding:10px;border-radius:8px;border:none;font-weight:600;">✏️ Edit Product</button>` : ''}
          <button class="btn" onclick="hideScanResult()" style="flex:1;background:#64748B;color:#fff;padding:10px;border-radius:8px;border:none;font-weight:600;">✕ Cancel</button>
        </div>
      </div>
    </div>
    
    <style>
      @keyframes pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.02); }
      }
    </style>
  `;
  
  // Store data for saving
  widget.dataset.parsed = JSON.stringify(parsed);
  widget.dataset.product = product ? JSON.stringify(product) : '';
  widget.dataset.barcode = barcodeDisplay;
  
  widget.classList.add('show');
  
  // Focus on first empty field
  setTimeout(() => {
    if (!found) {
      const nameInput = document.getElementById('srwName');
      if (nameInput && !nameInput.value) nameInput.focus();
    } else {
      const expiryInput = document.getElementById('srwExpiryText');
      if (expiryInput && !expiryInput.value) expiryInput.focus();
    }
  }, 100);
}

// Handle DDMMYY expiry input and convert to ISO
function handleExpiryInput(input) {
  const val = input.value.replace(/\D/g, '');
  input.value = val;
  
  if (val.length === 6) {
    const dd = parseInt(val.slice(0, 2));
    const mm = parseInt(val.slice(2, 4));
    const yy = parseInt(val.slice(4, 6));
    
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      const isoDate = `${year}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
      document.getElementById('srwExpiry').value = isoDate;
      
      // Show preview
      const preview = document.getElementById('expiryPreview');
      const status = GS1.getStatus(isoDate);
      const days = GS1.getDays(isoDate);
      preview.style.display = 'block';
      preview.innerHTML = `📅 ${dd}/${mm}/${year} — <span style="color:${status === 'expired' ? '#DC2626' : status === 'expiring' ? '#D97706' : '#059669'}">${status === 'expired' ? 'EXPIRED' : days + ' days left'}</span>`;
    }
  } else {
    document.getElementById('expiryPreview').style.display = 'none';
  }
}

// Auto-move cursor to batch after 6 digits
function autoMoveToBatch(input) {
  if (input.value.length >= 6) {
    document.getElementById('srwBatch').focus();
  }
}

// Auto-move cursor to qty after batch (4-6 chars or Enter)
function autoMoveToQty(input) {
  if (event.key === 'Enter' || (input.value.length >= 4 && event.key >= '0' && event.key <= '9' && input.value.length >= 6)) {
    document.getElementById('srwQty').focus();
    document.getElementById('srwQty').select();
  }
}

// Save as new product to master
async function saveAsNewProduct() {
  const widget = document.getElementById('scanResultWidget');
  const parsed = JSON.parse(widget.dataset.parsed);
  const barcode = widget.dataset.barcode.replace(/\D/g, '');
  
  // Get all field values
  const newProduct = {
    barcode: barcode,
    name: document.getElementById('srwName')?.value.trim() || 'Unknown Product',
    rms: document.getElementById('srwRms')?.value.trim() || '',
    alshayaCode: document.getElementById('srwAlshaya')?.value.trim() || '',
    brand: document.getElementById('srwBrand')?.value.trim() || '',
    supplier: document.getElementById('srwSupplier')?.value.trim() || '',
    returnPolicy: document.getElementById('srwReturn')?.value || 'NO',
    status: 'Active'
  };
  
  // Validate name
  if (!newProduct.name || newProduct.name === 'Unknown Product') {
    toast('Please enter product name', 'error');
    document.getElementById('srwName')?.focus();
    return;
  }
  
  // Save to master database
  await DB.addMasterProduct(newProduct);
  
  // Add to local Maps for instant lookup
  Matcher.addProduct(newProduct);
  
  // Now save to history
  const expiry = document.getElementById('srwExpiry')?.value || '';
  const batch = document.getElementById('srwBatch')?.value.trim() || '';
  const qty = parseInt(document.getElementById('srwQty')?.value) || 1;
  
  const historyItem = {
    ...parsed,
    ...newProduct,
    expiryISO: expiry,
    expiryDisplay: expiry ? formatDateDisplay(expiry) : '',
    batch: batch,
    qty: qty,
    timestamp: Date.now(),
    category: 'medicine'
  };
  
  await DB.addHistory(historyItem);
  await refreshUI();
  
  hideScanResult();
  haptic(80);
  toast('✅ Product added to Master & saved!', 'success');
}

// Edit existing product in master
function editProductMaster() {
  const widget = document.getElementById('scanResultWidget');
  const product = widget.dataset.product ? JSON.parse(widget.dataset.product) : {};
  const barcode = widget.dataset.barcode;
  
  // Show edit modal for master product
  showMasterEditModal(barcode, product);
}

// Master Edit Modal
function showMasterEditModal(barcode, product) {
  let modal = document.getElementById('masterEditModal');
  
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'masterEditModal';
    modal.className = 'edit-modal';
    document.body.appendChild(modal);
  }
  
  modal.innerHTML = `
    <div class="edit-content" style="max-width:400px;">
      <div class="edit-header">
        <span>✏️ Edit Master Product</span>
        <button class="edit-close" onclick="closeMasterEditModal()">✕</button>
      </div>
      <div class="edit-body" style="padding:16px;">
        <div class="form-group">
          <label class="form-label">BARCODE</label>
          <input type="text" id="meBarcode" class="form-input mono" value="${barcode}" readonly style="background:#f1f5f9;">
        </div>
        <div class="form-group">
          <label class="form-label">DESCRIPTION *</label>
          <input type="text" id="meName" class="form-input" value="${escapeHtml(product.name || '')}" placeholder="Product name">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group">
            <label class="form-label">RMS ID</label>
            <input type="text" id="meRms" class="form-input mono" value="${product.rms || ''}" placeholder="RMS">
          </div>
          <div class="form-group">
            <label class="form-label">ALSHAYA CODE</label>
            <input type="text" id="meAlshaya" class="form-input mono" value="${product.alshayaCode || ''}" placeholder="Alshaya">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group">
            <label class="form-label">BRAND</label>
            <input type="text" id="meBrand" class="form-input" value="${escapeHtml(product.brand || '')}" placeholder="Brand">
          </div>
          <div class="form-group">
            <label class="form-label">SUPPLIER</label>
            <input type="text" id="meSupplier" class="form-input" value="${escapeHtml(product.supplier || '')}" placeholder="Supplier">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">RETURN POLICY</label>
          <select id="meReturn" class="form-input">
            <option value="NO" ${product.returnPolicy !== 'YES' ? 'selected' : ''}>✓ Returnable</option>
            <option value="YES" ${product.returnPolicy === 'YES' ? 'selected' : ''}>🚫 Non-Returnable</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">SPECIAL NOTES</label>
          <textarea id="meNotes" class="form-input" rows="2" placeholder="Special directions...">${escapeHtml(product.notes || product.specialNotes || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;">
          <button class="btn btn-primary" onclick="saveMasterEdit()" style="flex:1;">💾 Save Changes</button>
          <button class="btn btn-ghost" onclick="closeMasterEditModal()" style="flex:1;">Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  modal.classList.add('show');
}

async function saveMasterEdit() {
  const barcode = document.getElementById('meBarcode').value;
  const updatedProduct = {
    barcode: barcode,
    name: document.getElementById('meName').value.trim(),
    rms: document.getElementById('meRms').value.trim(),
    alshayaCode: document.getElementById('meAlshaya').value.trim(),
    brand: document.getElementById('meBrand').value.trim(),
    supplier: document.getElementById('meSupplier').value.trim(),
    returnPolicy: document.getElementById('meReturn').value,
    notes: document.getElementById('meNotes').value.trim(),
    status: 'Active'
  };
  
  if (!updatedProduct.name) {
    toast('Name required', 'error');
    return;
  }
  
  await DB.updateMasterProduct(updatedProduct);
  Matcher.addProduct(updatedProduct);
  
  closeMasterEditModal();
  hideScanResult();
  toast('✅ Master updated!', 'success');
}

function closeMasterEditModal() {
  document.getElementById('masterEditModal')?.classList.remove('show');
}

function hideScanResult() {
  document.getElementById('scanResultWidget')?.classList.remove('show');
}

function adjustSrwQty(delta) {
  const input = document.getElementById('srwQty');
  input.value = Math.max(1, parseInt(input.value || 1) + delta);
}

function scanProductBarcode() {
  const widget = document.getElementById('scanResultWidget');
  App.pendingItem = JSON.parse(widget.dataset.parsed);
  App.scanMode = 'product';
  hideScanResult();
  Scanner.start();
}

async function saveScanResult() {
  const widget = document.getElementById('scanResultWidget');
  const parsed = JSON.parse(widget.dataset.parsed);
  const product = widget.dataset.product ? JSON.parse(widget.dataset.product) : {};
  
  // Get manual values
  const manualExpiry = document.getElementById('srwExpiry')?.value;
  const manualBatch = document.getElementById('srwBatch')?.value;
  const qty = parseInt(document.getElementById('srwQty')?.value) || 1;
  
  const entry = {
    raw: parsed.raw,
    gtin: parsed.gtin,
    scannedBarcode: parsed.gtin13 || parsed.gtin?.slice(-13) || parsed.raw?.replace(/\D/g, '').slice(0,13),
    name: product.name || 'Unknown Product',
    rms: product.rms || '',
    alshayaCode: product.alshayaCode || '',
    brand: product.brand || '',
    supplier: product.supplier || '',
    conceptGroup: product.conceptGroup || '',
    returnPolicy: product.returnPolicy || '',
    keyBrands: product.keyBrands || '',
    status: product.status || '',
    matchType: product.matchType || 'NONE',
    expiryISO: manualExpiry || parsed.expiryISO || '',
    expiryDisplay: manualExpiry ? formatDateDisplay(manualExpiry) : parsed.expiryDisplay || '',
    batch: manualBatch || parsed.batch || '',
    qty: qty,
    category: 'medicine',
    remarks: '',
    storeName: App.settings.storeName,
    isGS1: parsed.isGS1
  };
  
  await DB.addHistory(entry);
  hideScanResult();
  toast(`Saved: ${entry.name}`, 'success');
  haptic('success');
  await refreshUI();
}

function clearPending() {
  App.pendingItem = null;
  App.scanMode = 'normal';
}

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  const [history, master] = await Promise.all([DB.getAllHistory(), DB.getAllMaster()]);
  
  document.getElementById('masterCount').textContent = master.length;
  document.getElementById('historyCount').textContent = history.length;
  
  Matcher.build(master);
  
  history.sort((a, b) => b.timestamp - a.timestamp);
  renderHistory('recentScans', history.slice(0, 5), 'emptyRecent');
  renderHistory('historyList', filterHistory(history), 'emptyHistory');
}

function filterHistory(history) {
  let filtered = history;
  
  if (App.filter !== 'all') {
    if (App.categories.find(c => c.id === App.filter)) {
      filtered = history.filter(h => h.category === App.filter);
    } else {
      filtered = history.filter(h => GS1.getStatus(h.expiryISO) === App.filter);
    }
  }
  
  if (App.search) {
    const q = App.search.toLowerCase();
    filtered = filtered.filter(h =>
      h.name?.toLowerCase().includes(q) ||
      h.gtin?.includes(q) ||
      h.rms?.includes(q) ||
      h.batch?.toLowerCase().includes(q) ||
      h.brand?.toLowerCase().includes(q)
    );
  }
  
  return filtered;
}

function renderHistory(containerId, items, emptyId) {
  const container = document.getElementById(containerId);
  const empty = document.getElementById(emptyId);
  
  if (!items.length) {
    container.innerHTML = '';
    if (empty) { container.appendChild(empty); empty.classList.remove('hidden'); }
    return;
  }
  
  if (empty) empty.classList.add('hidden');
  container.innerHTML = items.map(item => {
    const status = GS1.getStatus(item.expiryISO);
    const days = GS1.getDays(item.expiryISO);
    const cat = App.categories.find(c => c.id === item.category) || App.categories[5];
    
    let badge = '<span class="badge badge-ok">OK</span>';
    if (status === 'expired') badge = '<span class="badge badge-expired">EXP</span>';
    else if (status === 'expiring') badge = `<span class="badge badge-expiring">${days}d</span>`;
    
    return `
      <div class="history-item ${status}" onclick="editItem(${item.id})">
        <div class="item-icon" style="background:${cat.color}">${cat.icon}</div>
        <div class="item-info">
          <div class="item-name">${escapeHtml(item.name)}</div>
          <div class="item-details">${item.expiryDisplay || '-'} • ${item.batch || '-'}</div>
        </div>
        ${badge}
        <div class="qty-controls" onclick="event.stopPropagation()">
          <button class="qty-btn" onclick="adjustQty(${item.id},-1)">−</button>
          <span class="qty-value">${item.qty || 1}</span>
          <button class="qty-btn" onclick="adjustQty(${item.id},1)">+</button>
        </div>
      </div>
    `;
  }).join('');
}

async function adjustQty(id, delta) {
  const item = await DB.getHistory(id);
  if (item) {
    item.qty = Math.max(1, (item.qty || 1) + delta);
    await DB.updateHistory(item);
    haptic('light');
    await refreshUI();
  }
}

// ============================================
// EXPORT
// ============================================
async function exportCSV() {
  const history = await DB.getAllHistory();
  if (!history.length) { toast('No data', 'warning'); return; }
  
  const headers = ['STORE NAME', 'RMS CODE', 'BARCODE', 'ALSHAYA CODE', 'DESCRIPTION', 'BRAND', 'SUPPLIER', 'CONCEPT GROUP', 'RETURN POLICY', 'KEY BRANDS', 'QTY', 'EXPIRY DATE', 'BATCH NO', 'STATUS', 'REMARKS'];
  
  const rows = history.map(h => [
    h.storeName || App.settings.storeName,
    h.rms || '',
    h.scannedBarcode || '',
    h.alshayaCode || '',
    h.name || '',
    h.brand || '',
    h.supplier || '',
    h.conceptGroup || '',
    h.returnPolicy || '',
    h.keyBrands || '',
    h.qty || 1,
    h.expiryDisplay || '',
    h.batch || '',
    GS1.getStatus(h.expiryISO).toUpperCase(),
    h.remarks || ''
  ]);
  
  let csv = headers.join(',') + '\n';
  rows.forEach(row => {
    csv += row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n';
  });
  
  download(csv, `expiry-${formatDateFile()}.csv`, 'text/csv');
  toast('Exported', 'success');
}

async function exportTSV() {
  const history = await DB.getAllHistory();
  if (!history.length) { toast('No data', 'warning'); return; }
  
  const headers = ['BARCODE', 'RMS ID', 'ALSHAYA CODE', 'DESCRIPTION', 'BRAND', 'SUPPLIER', 'QTY', 'EXPIRY DATE', 'BATCH NO'];
  
  const rows = history.map(h => [
    h.scannedBarcode || '',
    h.rms || '',
    h.alshayaCode || '',
    h.name || '',
    h.brand || '',
    h.supplier || '',
    h.qty || 1,
    h.expiryISO ? excelDate(h.expiryISO) : '',
    h.batch || ''
  ]);
  
  let tsv = headers.join('\t') + '\n';
  rows.forEach(row => { tsv += row.join('\t') + '\n'; });
  
  download(tsv, `expiry-${formatDateFile()}.tsv`, 'text/tab-separated-values');
  toast('Exported for Excel', 'success');
}

// ============================================
// MASTER DATA BACKUP & RESTORE
// ============================================
async function backupMaster() {
  const master = await DB.getAllMaster();
  if (!master.length) { toast('No master data to backup', 'warning'); return; }
  
  const backup = {
    version: CONFIG.VERSION,
    exportDate: new Date().toISOString(),
    storeName: App.settings.storeName,
    productCount: master.length,
    products: master
  };
  
  const json = JSON.stringify(backup, null, 2);
  download(json, `master-backup-${formatDateFile()}.json`, 'application/json');
  toast(`✅ Backed up ${master.length} products`, 'success');
}

async function restoreMaster(file) {
  try {
    const text = await file.text();
    
    // Try JSON first
    if (file.name.endsWith('.json')) {
      const data = JSON.parse(text);
      const products = data.products || data;
      
      if (!Array.isArray(products)) {
        toast('Invalid backup file', 'error');
        return;
      }
      
      const count = await DB.bulkAddMaster(products);
      Matcher.build(products);
      toast(`✅ Restored ${count} products`, 'success');
      await refreshUI();
      return;
    }
    
    // CSV format
    const lines = text.trim().split(/[\r\n]+/);
    if (lines.length < 2) { toast('Invalid file', 'error'); return; }
    
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const cols = lines[0].toLowerCase().split(delim).map(c => c.trim().replace(/['"]/g, ''));
    
    const idx = {
      barcode: cols.findIndex(c => /barcode|gtin/.test(c)),
      name: cols.findIndex(c => /description|name/.test(c)),
      rms: cols.findIndex(c => /rms/.test(c)),
      alshaya: cols.findIndex(c => /alshaya/.test(c) && !/new/.test(c)),
      newAlshaya: cols.findIndex(c => /new.*alshaya/.test(c)),
      brand: cols.findIndex(c => /brand/.test(c)),
      supplier: cols.findIndex(c => /supplier/.test(c)),
      returnPolicy: cols.findIndex(c => /return/.test(c)),
      notes: cols.findIndex(c => /note|direction/.test(c))
    };
    
    if (idx.barcode === -1) { toast('No barcode column', 'error'); return; }
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g, ''));
      const bc = (row[idx.barcode] || '').replace(/\D/g, '');
      if (bc.length >= 8) {
        items.push({
          barcode: bc,
          name: idx.name >= 0 ? row[idx.name] : '',
          rms: idx.rms >= 0 ? row[idx.rms] : '',
          alshayaCode: idx.alshaya >= 0 ? row[idx.alshaya] : '',
          newAlshayaCode: idx.newAlshaya >= 0 ? row[idx.newAlshaya] : '',
          brand: idx.brand >= 0 ? row[idx.brand] : '',
          supplier: idx.supplier >= 0 ? row[idx.supplier] : '',
          returnPolicy: idx.returnPolicy >= 0 ? row[idx.returnPolicy] : 'NO',
          notes: idx.notes >= 0 ? row[idx.notes] : '',
          status: 'Active'
        });
      }
    }
    
    const count = await DB.bulkAddMaster(items);
    Matcher.build(items);
    toast(`✅ Restored ${count} products`, 'success');
    await refreshUI();
  } catch (e) {
    console.error(e);
    toast('Restore failed', 'error');
  }
}

async function clearMasterData() {
  if (!confirm('⚠️ Clear ALL master data?\n\nThis will remove all product information.\nYou should backup first!')) return;
  
  await DB.clearMaster();
  App.master.clear();
  App.masterRMS.clear();
  App.masterAlshaya.clear();
  toast('Master data cleared', 'success');
  await refreshUI();
}

function excelDate(iso) {
  const d = new Date(iso);
  return Math.floor((d - new Date(1899, 11, 30)) / 86400000);
}

// ============================================
// MASTER UPLOAD
// ============================================
async function uploadMaster(file) {
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    if (lines.length < 2) { toast('Invalid file', 'error'); return; }
    
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const cols = lines[0].toLowerCase().split(delim).map(c => c.trim().replace(/['"]/g, ''));
    
    console.log('📊 CSV Columns:', cols);
    
    // Find columns - handle multiple variations
    const idx = {
      barcode: cols.findIndex(c => /barcode|gtin|ean|upc/.test(c) && !/scan/.test(c)),
      name: cols.findIndex(c => /^description$|^name$|^product$/.test(c)),
      rms: cols.findIndex(c => /^rms$|^rms.?id$|^rms.?code$/.test(c)),
      alshaya: cols.findIndex(c => /^alshaya.?code$/.test(c) && !/new/.test(c)),
      newAlshaya: cols.findIndex(c => /new.?alshaya/.test(c)),
      brand: cols.findIndex(c => /^brand$/.test(c)),
      supplier: cols.findIndex(c => /supplier/.test(c)),
      concept: cols.findIndex(c => /concept/.test(c)),
      returnPolicy: cols.findIndex(c => /return/.test(c)),
      keyBrands: cols.findIndex(c => /key.*brand/.test(c)),
      status: cols.findIndex(c => /^status$/.test(c))
    };
    
    console.log('📋 Column indexes:', idx);
    
    if (idx.barcode === -1) { toast('No barcode column found', 'error'); return; }
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g, ''));
      const bc = (row[idx.barcode] || '').replace(/\D/g, '');
      if (bc.length >= 8) {
        items.push({
          barcode: bc,
          name: idx.name >= 0 ? row[idx.name] : '',
          rms: idx.rms >= 0 ? row[idx.rms] : '',
          alshayaCode: idx.alshaya >= 0 ? row[idx.alshaya] : '',
          newAlshayaCode: idx.newAlshaya >= 0 ? row[idx.newAlshaya] : '',
          brand: idx.brand >= 0 ? row[idx.brand] : '',
          supplier: idx.supplier >= 0 ? row[idx.supplier] : '',
          conceptGroup: idx.concept >= 0 ? row[idx.concept] : '',
          returnPolicy: idx.returnPolicy >= 0 ? row[idx.returnPolicy] : '',
          keyBrands: idx.keyBrands >= 0 ? row[idx.keyBrands] : '',
          status: idx.status >= 0 ? row[idx.status] : 'Active'
        });
      }
    }
    
    const count = await DB.bulkAddMaster(items);
    await refreshUI();
    toast(`✅ Uploaded ${count} products`, 'success');
    document.getElementById('lastUpdated').textContent = 'Now';
  } catch (e) {
    console.error(e);
    toast('Upload failed', 'error');
  }
}

// ============================================
// EDIT MODAL
// ============================================
async function editItem(id) {
  const item = await DB.getHistory(id);
  if (!item) return;
  
  App.editingId = id;
  document.getElementById('editName').value = item.name || '';
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editAlshaya').value = item.alshayaCode || '';
  document.getElementById('editBrand').value = item.brand || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editCategory').value = item.category || 'medicine';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editRemarks').value = item.remarks || '';
  document.getElementById('editModal').classList.add('show');
}

async function saveEdit() {
  const item = await DB.getHistory(App.editingId);
  if (!item) return;
  
  item.name = document.getElementById('editName').value.trim();
  item.rms = document.getElementById('editRms').value.trim();
  item.alshayaCode = document.getElementById('editAlshaya').value.trim();
  item.brand = document.getElementById('editBrand').value.trim();
  item.qty = parseInt(document.getElementById('editQty').value) || 1;
  item.category = document.getElementById('editCategory').value;
  item.expiryISO = document.getElementById('editExpiry').value;
  item.expiryDisplay = item.expiryISO ? formatDateDisplay(item.expiryISO) : '';
  item.batch = document.getElementById('editBatch').value.trim();
  item.remarks = document.getElementById('editRemarks').value.trim();
  
  await DB.updateHistory(item);
  closeEditModal();
  await refreshUI();
  toast('Saved', 'success');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
  App.editingId = null;
}

async function deleteItem() {
  if (confirm('Delete this item?')) {
    await DB.deleteHistory(App.editingId);
    closeEditModal();
    await refreshUI();
    toast('Deleted', 'success');
  }
}

// ============================================
// UTILITIES
// ============================================
function toast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-icon">${{success:'✓',error:'✕',warning:'⚠',info:'ℹ'}[type]}</div><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
}

function haptic(type) {
  if (!App.settings.hapticEnabled || !navigator.vibrate) return;
  navigator.vibrate({light:10,medium:25,success:[20,40,20],error:[80,40,80]}[type] || 10);
}

function escapeHtml(s) { return s ? String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) : ''; }
function formatDateDisplay(iso) { if (!iso) return ''; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
function formatDateFile() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function download(content, name, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type})); a.download = name; a.click(); }

// ============================================
// NAVIGATION & EVENTS
// ============================================
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${id}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-page="${id}"]`)?.classList.add('active');
  if (id !== 'home' && App.scanner.active) Scanner.stop();
  closeSideMenu();
}

function openSideMenu() { document.getElementById('sideMenuBg').classList.add('show'); document.getElementById('sideMenu').classList.add('show'); }
function closeSideMenu() { document.getElementById('sideMenuBg').classList.remove('show'); document.getElementById('sideMenu').classList.remove('show'); }

function setupEvents() {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.onclick = () => showPage(btn.dataset.page));
  
  document.getElementById('btnScanner').onclick = () => Scanner.toggle();
  document.getElementById('scannerFrame').onclick = () => { if (!App.scanner.active) Scanner.start(); };
  
  document.getElementById('manualInput').onkeypress = e => { if (e.key === 'Enter') processBarcode(document.getElementById('manualInput').value); };
  document.getElementById('btnManualAdd').onclick = () => processBarcode(document.getElementById('manualInput').value);
  
  document.getElementById('viewAllHistory').onclick = () => showPage('history');
  document.getElementById('searchInput').oninput = e => { App.search = e.target.value; refreshUI(); };
  
  document.querySelectorAll('.chip').forEach(chip => chip.onclick = () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    App.filter = chip.dataset.filter;
    refreshUI();
  });
  
  document.getElementById('btnProcessBulk').onclick = processBulk;
  document.getElementById('btnClearBulk').onclick = () => { document.getElementById('bulkInput').value = ''; };
  
  document.getElementById('uploadArea').onclick = () => document.getElementById('masterFileInput').click();
  document.getElementById('masterFileInput').onchange = e => { if (e.target.files[0]) { uploadMaster(e.target.files[0]); e.target.value = ''; } };
  
  const darkToggle = document.getElementById('toggleDarkMode');
  if (darkToggle) darkToggle.onclick = function() { this.classList.toggle('on'); document.body.classList.toggle('dark-mode'); };
  const apiToggle = document.getElementById('toggleApi');
  if (apiToggle) apiToggle.onclick = function() { this.classList.toggle('on'); App.settings.apiEnabled = this.classList.contains('on'); };
  const hapticToggle = document.getElementById('toggleHaptic');
  if (hapticToggle) hapticToggle.onclick = function() { this.classList.toggle('on'); App.settings.hapticEnabled = this.classList.contains('on'); };
  
  document.getElementById('btnExportCSV').onclick = exportCSV;
  const tsvBtn = document.getElementById('btnExportTSV');
  if (tsvBtn) tsvBtn.onclick = exportTSV;
  document.getElementById('btnClearAll').onclick = async () => { if (confirm('Clear all?')) { await DB.clearHistory(); await refreshUI(); toast('Cleared', 'success'); } };
  
  document.getElementById('btnMenu').onclick = openSideMenu;
  document.getElementById('sideMenuBg').onclick = closeSideMenu;
  document.getElementById('menuExport').onclick = () => { closeSideMenu(); exportCSV(); };
  document.getElementById('menuClear').onclick = async () => { closeSideMenu(); if (confirm('Clear history?')) { await DB.clearHistory(); await refreshUI(); toast('History cleared', 'success'); } };
  document.getElementById('menuAbout').onclick = () => { closeSideMenu(); alert(`GS1 Tracker v${CONFIG.VERSION}\n\nDeveloped for OASIS PHARMACY\nAll products and scans saved locally.`); };
  
  // Master data menu handlers
  const menuBackup = document.getElementById('menuBackupMaster');
  if (menuBackup) menuBackup.onclick = () => { closeSideMenu(); backupMaster(); };
  
  const menuRestore = document.getElementById('menuRestoreMaster');
  if (menuRestore) menuRestore.onclick = () => { closeSideMenu(); document.getElementById('masterRestoreInput').click(); };
  
  const menuClearMaster = document.getElementById('menuClearMaster');
  if (menuClearMaster) menuClearMaster.onclick = () => { closeSideMenu(); clearMasterData(); };
  
  const masterRestoreInput = document.getElementById('masterRestoreInput');
  if (masterRestoreInput) masterRestoreInput.onchange = e => { if (e.target.files[0]) { restoreMaster(e.target.files[0]); e.target.value = ''; } };
  
  const menuStore = document.getElementById('menuStore');
  if (menuStore) menuStore.onclick = () => { closeSideMenu(); showStoreModal(); };
  
  document.getElementById('btnCancelEdit').onclick = closeEditModal;
  document.getElementById('btnSaveEdit').onclick = saveEdit;
  const deleteBtn = document.getElementById('btnDeleteEdit');
  if (deleteBtn) deleteBtn.onclick = deleteItem;
  document.getElementById('editModal').onclick = e => { if (e.target.id === 'editModal') closeEditModal(); };
  
  const saveStoreBtn = document.getElementById('btnSaveStore');
  if (saveStoreBtn) saveStoreBtn.onclick = () => {
    App.settings.storeName = document.getElementById('storeNameInput').value.trim() || CONFIG.STORE_NAME;
    DB.setSetting('storeName', App.settings.storeName);
    document.getElementById('storeModal').classList.remove('show');
    toast('Saved', 'success');
  };
  
  window.addEventListener('online', () => document.getElementById('offlineTag').classList.remove('show'));
  window.addEventListener('offline', () => document.getElementById('offlineTag').classList.add('show'));
}

function showStoreModal() {
  document.getElementById('storeNameInput').value = App.settings.storeName || '';
  document.getElementById('storeModal').classList.add('show');
}

async function processBulk() {
  const text = document.getElementById('bulkInput').value.trim();
  if (!text) return;
  
  const lines = text.split(/[\r\n]+/).filter(l => l.trim());
  let total = 0, valid = 0, matched = 0;
  
  for (const line of lines) {
    total++;
    const parsed = GS1.parse(line.trim());
    if (parsed.gtin || parsed.gtin13) {
      valid++;
      const product = Matcher.find(parsed.gtin || parsed.gtin13 || line);
      if (product) matched++;
      
      await DB.addHistory({
        raw: line,
        gtin: parsed.gtin,
        scannedBarcode: parsed.gtin13 || parsed.gtin?.slice(-13),
        name: product?.name || 'Unknown',
        rms: product?.rms || '',
        alshayaCode: product?.alshayaCode || '',
        brand: product?.brand || '',
        supplier: product?.supplier || '',
        matchType: product?.matchType || 'NONE',
        expiryISO: parsed.expiryISO,
        expiryDisplay: parsed.expiryDisplay,
        batch: parsed.batch,
        qty: 1,
        category: 'medicine',
        storeName: App.settings.storeName,
        isGS1: parsed.isGS1
      });
    }
  }
  
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statValid').textContent = valid;
  document.getElementById('statMatched').textContent = matched;
  
  await refreshUI();
  toast(`Processed ${valid}/${total}`, 'success');
  document.getElementById('bulkInput').value = '';
}

// ============================================
// INIT
// ============================================
async function init() {
  console.log('🚀 GS1 Tracker v' + CONFIG.VERSION);
  
  try {
    await DB.init();
    App.settings.storeName = await DB.getSetting('storeName', CONFIG.STORE_NAME);
    App.settings.apiEnabled = await DB.getSetting('apiEnabled', false);
    
    document.getElementById('toggleApi')?.classList.toggle('on', App.settings.apiEnabled);
    
    setupEvents();
    await refreshUI();
    
    if (!navigator.onLine) document.getElementById('offlineTag').classList.add('show');
    console.log('✅ Ready');
  } catch (e) {
    console.error(e);
    toast('Init error', 'error');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
