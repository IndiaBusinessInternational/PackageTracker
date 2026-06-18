// ============================================================
//  IBI PACKAGE TRACKER — Complete Google Apps Script
//  BACKEND BUILD: v1.7  (2026-06-18)
//  ----------------------------------------------------------
//  v1.7 CHANGELOG (Flipkart duplicate-row fix):
//   • ROOT CAUSE of "5 Flipkart rows instead of 4": on a re-ship
//     the same Flipkart order arrives once as the bare Order ID
//     (OD…) and once with the Invoice No glued on (OD…-LWACJIC…),
//     each with its own AWB/invoice. All four dedup tiers missed
//     it, so a 5th row was created.
//   • FIX (Flipkart/Shopsy ONLY): normaliseId() now collapses any
//     "od"+15-22 digits value to its bare base, so the OrderID
//     dedup tiers — and the Remove Duplicates grouping — treat the
//     bare and invoice-suffixed forms as one order. The stored
//     Order ID is also collapsed at write time via
//     collapseFkOrderId() so new rows hold the clean base.
//   • Meesho _1/_2 sub-orders, Amazon IDs, AWBs and Invoice Nos are
//     UNTOUCHED (the "^od\d{15,22}" guard matches Flipkart only).
//   • Existing extra rows clear with one click of "Remove
//     Duplicates" (now groups the bare + suffixed forms together).
//  ----------------------------------------------------------
//  v1.6 CHANGELOG (corrected diagnosis — date was the only bug):
//   • Seller Central confirmed the orders that looked like a
//     "false Delivered" were GENUINELY delivered — they only
//     looked implausible because their date was day/month
//     swapped (real Feb 6 shown as June 2). The status pipeline
//     was never wrong.
//   • REVERTED the speculative delivery-plausibility guard and the
//     reVerifyDelivered action added in v1.4/v1.5. trackCourier()
//     is once again FAITHFUL to the carrier — status is not
//     second-guessed (that risked corrupting correct "Delivered").
//   • KEPT the real fix: toIsoDate() ISO date writing + plain-text
//     date columns (prevents the US-locale day/month swap at the
//     source), the notifyERP() orderId fix, and the reTrackAll
//     null-guard.
//  ----------------------------------------------------------
//  v1.4 CHANGELOG (permanent date fix — the part that stays):
//   • ROOT-CAUSE DATE FIX — all invoice/order/ship/expected
//     dates are now written as ISO "YYYY-MM-DD" via toIsoDate(),
//     and the 4 date columns are forced to PLAIN-TEXT (@STRING@)
//     in getSheet(). The US-locale sheet can no longer re-read a
//     day-first date like "06/02/2026" (Feb 6) as June 2. The ERP
//     reads ISO unambiguously.
//   • notifyERP() — fixed undefined `orderId` ReferenceError that
//     silently broke the auto-push to the ERP; dates sent as ISO.
//   • reTrackAll() — null-guard when all tracking APIs fail.
//   • Extraction prompt — stronger Flipkart product capture from
//     the tax-invoice table (label alone often omits it).
//  ----------------------------------------------------------
//  Sheet  : https://docs.google.com/spreadsheets/d/1VjK5oA6mCZVXZ2AhfZYtb0kVAkB549bSUB4iQ4eW7f0
//  Tab    : "Package Tracker" (auto-created on first use)
//
//  SETUP — Script Properties (⚙️ Project Settings):
//    GEMINI_API_KEY  →  AIzaSy...
//    OPENAI_API_KEY  →  sk-...
//    CLAUDE_API_KEY  →  sk-ant-...
//    ACTIVE_AI       →  gemini  (default)
//
//  ACTIONS:
//    extractOnly     — PDF → AI extract only (for review step)
//    confirmPackage  — save confirmed/edited data → track → sheet
//    reTrack         — re-check one package in-place
//    reTrackAll      — re-check all non-final packages
//    loadPackages    — return all rows as JSON
//    getSettings     — return active AI + key status
//    saveSettings    — save active AI or update API keys
// ============================================================

const SHEET_ID   = '1VjK5oA6mCZVXZ2AhfZYtb0kVAkB549bSUB4iQ4eW7f0';
const SHEET_NAME = 'Package Tracker';

const C = {
  SAVED_ON:1,  PLATFORM:2,     COURIER:3,    ORDER_ID:4,
  AWB:5,       INVOICE_NO:6,   INVOICE_DATE:7, ORDER_DATE:8,
  BUYER_NAME:9, BUYER_PHONE:10, SHIP_ADDR:11, BILL_ADDR:12,
  PINCODE:13,  PRODUCTS:14,    QTY:15,       AMOUNT:16,
  PAY_TYPE:17, SHIP_DATE:18,   EXP_DEL:19,
  STATUS:20,   STATUS_DTL:21,  TRACK_URL:22, LAST_TRACKED:23
};

const HEADERS = [
  'Saved On','Platform','Courier','Order ID','AWB / Tracking No',
  'Invoice No','Invoice Date','Order Date',
  'Buyer Name','Buyer Phone','Shipping Address','Billing Address','Pincode',
  'Products / SKU','Qty','Amount (₹)','Payment Type','Ship Date',
  'Expected Delivery','Status','Status Detail','Tracking URL','Last Tracked'
];

const COURIER_MAP = {
  'Amazon':'Amazon Transportation Services',
  'Amazon Bazaar':'Amazon Transportation Services',
  'Flipkart':'eKart Logistics',
  'Shopsy':'eKart Logistics',
  'Meesho':'Delhivery',
  'ShopClues':'Delhivery',
  'IBI Website':'Delhivery'
};

const FINAL_STATUSES = ['Delivered','RTO Delivered','Lost in Transit','Rejected','Cancelled'];

/* ════════════════════════════════════════════════════════════
   ENTRY POINTS
════════════════════════════════════════════════════════════ */
function doPost(e) {
  try {
    const action = e.parameter.action;
    if (action === 'extractOnly')    return extractOnly(e);
    if (action === 'confirmPackage') return confirmPackage(e);
    if (action === 'confirmBatch')     return confirmBatch(e);
    if (action === 'deduplicateSheet') return deduplicateSheet();
    if (action === 'organizeSheets')   return organizeSheets();
    if (action === 'repairDates')      return repairDates(e);
    if (action === 'reTrack')        return reTrack(e);
    if (action === 'reTrackAll')     return reTrackAll();
    if (action === 'loadPackages')   return loadPackages();
    if (action === 'getSettings')    return getSettings();
    if (action === 'saveSettings')   return saveSettings(e);
    if (action === 'importReport')   return importReport(e);
    if (action === 'clearAll')             return clearAllPackages();
    if (action === 'fixTrackingUrls')      return fixTrackingUrls();
    if (action === 'cleanStaleData')       return cleanStaleData();
    if (action === 'sortSheet')            return sortByPlatformAndInvoice();
    if (action === 'separateByMonth')      return separateByMonth();
    if (action === 'removeDuplicates')     return removeDuplicates();
    if (action === 'getTracking')          return getTracking(e);
    if (action === 'testTracking')   return testTracking(e);
    return respond({ status:'error', message:'Unknown action: ' + action });
  } catch(err) {
    return respond({ status:'error', message: err.toString() });
  }
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status:'ok', message:'IBI Package Tracker GAS is live.' })
  ).setMimeType(ContentService.MimeType.JSON);
}

/* ════════════════════════════════════════════════════════════
   ACTION: extractOnly
   PDF → AI → return extracted JSON for user review
   Does NOT track or save — user reviews first
════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
   ACTION: extractOnly
   PDF → AI → return extracted JSON array for user review.
   Now handles multi-order PDFs — returns ALL orders found.
   Does NOT track or save — user reviews first.
════════════════════════════════════════════════════════════ */
function extractOnly(e) {
  const pdfBase64 = e.parameter.pdfData;
  if (!pdfBase64) return respond({ status:'error', message:'No PDF data received.', failedAt:1 });

  /* ══════════════════════════════════════════════════════════
     LAYER 1 — FILENAME REGEX (instant, no AI needed)
     Amazon invoice types identified by filename prefix:
       IN-xx   → Easy Ship   → Invoice + Shipping Label → AWB = TBA on label
       MAA4-xx → FBA Chennai → Invoice ONLY              → AWB = filename number
       CJB1-xx → FBA CBE     → Invoice ONLY              → AWB = filename number
       (more FBA prefixes may exist — same pattern applies)

     Filename format: {InvoiceNo}_{AWB}_{SHIPMENT_supplier_copy}.PDF
     Examples:
       CJB1-1_108259999944302_SHIPMENT_supplier_copy.PDF → AWB = 108259999944302
       IN-27_26197971027039_SHIPMENT_supplier_copy.PDF   → AWB = 26197971027039
  ══════════════════════════════════════════════════════════ */
  const fileName = (e.parameter.fileName || '').trim();
  Logger.log('extractOnly: fileName = ' + fileName);

  // Detect Amazon type from filename prefix
  var amazonType = '';
  if      (/^IN-\d/i.test(fileName))   amazonType = 'IN';
  else if (/^MAA4-/i.test(fileName))   amazonType = 'MAA4';
  else if (/^CJB1-/i.test(fileName))   amazonType = 'CJB1';
  // Generic FBA pattern: e.g. BLR3-, DEL7-, HYD1- etc.
  else if (/^[A-Z]{2,4}\d-/i.test(fileName) && fileName.toLowerCase().includes('shipment_supplier_copy')) amazonType = 'FBA';

  // Extract the AWB number from between invoice number and _SHIPMENT in filename
  // Pattern: anything _ {8-20 digits} _ SHIPMENT
  var filenameAwb = '';
  if (fileName) {
    var fnMatch = fileName.match(/_(\d{8,20})_SHIPMENT/i);
    if (!fnMatch) fnMatch = fileName.match(/_(\d{8,20})\.[a-z]{2,4}$/i);
    if (fnMatch) {
      filenameAwb = fnMatch[1];
      Logger.log('extractOnly: filenameAwb = ' + filenameAwb + ' | amazonType = ' + amazonType);
    }
  }

  // For FBA types (MAA4, CJB1, generic FBA): filename AWB is the ONLY source — no label in PDF
  // This flag causes us to FORCE the filename AWB regardless of what AI returns
  var isFbaInvoiceOnly = (amazonType === 'MAA4' || amazonType === 'CJB1' || amazonType === 'FBA');
  var awbIsDefinitive  = isFbaInvoiceOnly && filenameAwb !== '';

  /* ══════════════════════════════════════════════════════════
     LAYER 2 — PROMPT INJECTION
     Tell AI explicitly what AWB to use (or where to find it).
     Even if AI ignores this, Layer 3 catches it.
  ══════════════════════════════════════════════════════════ */
  var fileHint = '';
  if (fileName) {
    fileHint = '\n\nPDF FILENAME: ' + fileName + '\n';
    if (amazonType === 'IN') {
      fileHint +=
        '⚠️  AMAZON EASY SHIP (IN- type): This PDF has both Invoice AND Shipping Label.\n' +
        'Find the AWB on the shipping label. It is ONE of two formats:\n' +
        '  (a) TBA format  : starts with "TBA" + 12 digits, e.g. TBA012345678900\n' +
        '  (b) Numeric format: 12-15 digit number near the main barcode, e.g. 369674341636\n' +
        'Return ONLY the digits — do NOT include the word "AWB" in your answer.\n' +
        'CRITICAL: Use ONLY the AWB on THIS label; do not carry over AWBs from other PDFs.\n' +
        (filenameAwb ? 'Filename fallback AWB = ' + filenameAwb + ' (use ONLY if no AWB found on label).\n' : '');
    } else if (isFbaInvoiceOnly) {
      fileHint +=
        '⚠️  AMAZON FBA INVOICE ONLY (' + amazonType + '- type):\n' +
        'This PDF has NO shipping label page. There is NO TBA or AWB number anywhere in the document body.\n' +
        'THE AWB HAS BEEN PRE-EXTRACTED FROM THE FILENAME: ' + (filenameAwb || 'N/A') + '\n' +
        'YOU MUST set "awb" = "' + (filenameAwb || '') + '" EXACTLY.\n' +
        'DO NOT use the invoice number, invoice details, transaction ID, or any other field as the AWB.\n' +
        'DO NOT guess or invent a different AWB. Use ONLY: ' + (filenameAwb || '') + '\n';
    } else if (fileName.toLowerCase().includes('shipment_supplier_copy')) {
      fileHint +=
        'Amazon supplier copy PDF. AWB from filename = ' + (filenameAwb || 'unknown') + '.\n' +
        'Use this as awb if no TBA found in document.\n';
    } else if (/Amazon/i.test(fileName) && !/(Flipkart|Meesho|ShopClues|Shopsy)/i.test(fileName) && !isFbaInvoiceOnly) {
      // ── Custom-named Amazon Easy Ship PDF (e.g. "Amazon_Necklace_27_May.pdf") ──
      // The filename does not match any standard Amazon pattern, so no AWB could be
      // extracted from the filename. The PDF almost certainly contains BOTH an invoice
      // section AND a shipping label section. Extract the AWB from the shipping label.
      fileHint +=
        '⚠️  AMAZON EASY SHIP (custom filename): This PDF has both an Invoice section\n' +
        'AND a Shipping Label section.\n' +
        'Find the AWB (Air Waybill / Tracking Number) on the SHIPPING LABEL page.\n' +
        'It is ONE of two formats:\n' +
        '  (a) Numeric: 12-15 digit number printed near/below the main barcode,\n' +
        '      often labelled "AWB" or "AWB No." — e.g. 369674341636\n' +
        '  (b) TBA format: starts with "TBA" + 12 digits — e.g. TBA012503781000\n' +
        'Return ONLY the bare digits (or TBA+digits). Do NOT include "AWB" in the value.\n' +
        'CRITICAL: This PDF is processed in complete isolation.\n' +
        'Do NOT reuse or carry over any AWB, Order ID, or Invoice Number from any\n' +
        'other PDF you may have seen in this or any previous extraction.\n' +
        'Every field you return must come ONLY from the content of THIS single PDF.\n';
    }
  }

  const props    = PropertiesService.getScriptProperties();
  const activeAI = props.getProperty('ACTIVE_AI') || 'gemini';

  // PDF text layer extracted in the browser (PDF.js) for DeepSeek, whose
  // API is text-only. Gemini/Claude/OpenAI still read the PDF directly.
  var pdfText = (e.parameter.pdfText || '').trim();
  Logger.log('extractOnly: pdfText length = ' + pdfText.length + ' chars (for DeepSeek)');

  // DeepSeek goes first when it's the active provider; otherwise it's the
  // safety-net at the END of the chain — so if Gemini/Claude/OpenAI are all
  // out of quota, DeepSeek (cheap, free credits, no hard rate limit) still
  // extracts from the PDF text. No more "1 PDF failed".
  const aiOrder = activeAI === 'deepseek' ? ['deepseek','gemini','claude','openai']
                : activeAI === 'openai'   ? ['openai','claude','gemini','deepseek']
                : activeAI === 'claude'   ? ['claude','openai','gemini','deepseek']
                :                           ['gemini','claude','openai','deepseek'];

  let rawResult = null;
  let succeededWith = '';
  const attempts = [];   // human-readable trail of every provider we tried/skipped

  // Map provider -> {keyProp, fn} so the loop stays declarative and never
  // silently treats a key-less provider as if it had been "tried".
  const PROVIDERS = {
    openai:   { key:'OPENAI_API_KEY',   fn:function(){ return extractWithOpenAI(pdfBase64, fileHint); } },
    claude:   { key:'CLAUDE_API_KEY',   fn:function(){ return extractWithClaude(pdfBase64, fileHint); } },
    gemini:   { key:'GEMINI_API_KEY',   fn:function(){ return extractWithGemini(pdfBase64, fileHint); } },
    deepseek: { key:'DEEPSEEK_API_KEY', fn:function(){ return extractWithDeepSeekText(pdfText, fileHint); }, needsText:true }
  };

  for (const ai of aiOrder) {
    const cfg = PROVIDERS[ai];
    if (!cfg) continue;
    if (!props.getProperty(cfg.key)) {
      attempts.push(ai.toUpperCase() + ': skipped (no API key set)');
      continue;
    }
    if (cfg.needsText && !pdfText) {
      attempts.push(ai.toUpperCase() + ': skipped (no PDF text — even OCR produced nothing; check the file)');
      continue;
    }
    try {
      rawResult = cfg.fn();
      succeededWith = ai;
      break;
    } catch(err) {
      const msg = String(err && err.message || err);
      attempts.push(ai.toUpperCase() + ': ' + msg);
      Logger.log('extractOnly fallback — ' + ai.toUpperCase() + ': ' + msg);
      Utilities.sleep(500);
    }
  }

  if (!rawResult) {
    // Build a precise, actionable message. If the *only* failures were
    // quota/billing exhaustion, tell the operator exactly what to do instead
    // of returning a raw vendor error string that looks like a code crash.
    const trail = attempts.join('  |  ');

    // Classify a single attempt string into a recoverable-or-not bucket.
    const classify = function(a){
      if (/insufficient_quota|exceeded your current quota|check your plan and billing|billing|credit balance|payment/i.test(a)) return 'billing';
      if (/quota|RESOURCE_EXHAUSTED|rate|429|overloaded|503|529|too many requests|limit/i.test(a)) return 'rate_limit';
      return 'other';
    };
    // The ACTIVE provider is the first one we actually attempted (not skipped).
    const activeProvider = aiOrder.find(function(ai){
      return PROVIDERS[ai] && props.getProperty(PROVIDERS[ai].key);
    }) || aiOrder[0];
    const activeAttempt = attempts.find(function(a){ return a.indexOf('skipped') === -1; }) || '';
    const errorClass = classify(activeAttempt);            // drives the UI's retry-vs-switch decision

    const allQuota = attempts.length > 0 && attempts.every(function(a){
      return classify(a) !== 'other';
    });
    const message = allQuota
      ? 'All configured AI providers are out of quota / rate-limited. '
        + 'Open AI Settings and either (a) set the Active Provider to one with quota left '
        + '(Gemini has a free tier), or (b) add billing to the exhausted key. Detail: ' + trail
      : (trail || 'All AI providers failed. Check API keys in AI Settings.');
    return respond({
      status:'error', message: message, attempts: attempts, failedAt:2,
      errorClass: errorClass,
      provider: (activeProvider || 'AI provider').replace(/^./, function(c){ return c.toUpperCase(); })
    });
  }
  Logger.log('extractOnly: extracted via ' + succeededWith);

  // Normalise to array
  let orders = Array.isArray(rawResult) ? rawResult : [rawResult];
  Logger.log('extractOnly: AI returned ' + orders.length + ' order(s)');

  /* ══════════════════════════════════════════════════════════
     LAYER 3 — POST-PROCESS OVERRIDE (server-side guarantee)
     No matter what AI returned, enforce correct AWB here.
     This is the final safety net and ALWAYS runs last.
  ══════════════════════════════════════════════════════════ */
  orders = orders.map(function(extracted) {

    if (awbIsDefinitive) {
      // FBA Invoice-Only (MAA4/CJB1/FBA): overwrite unconditionally
      // The AWB is in the filename — what AI returned is irrelevant and likely wrong
      if (extracted.awb !== filenameAwb) {
        Logger.log('extractOnly: AWB override — AI had "' + (extracted.awb||'') + '" → forced to "' + filenameAwb + '" (' + amazonType + '-)');
      }
      extracted.awb = filenameAwb;

    } else if (!extracted.awb || extracted.awb.trim() === '') {
      // Any type: if AI found nothing, use filename as fallback
      if (filenameAwb) {
        extracted.awb = filenameAwb;
        Logger.log('extractOnly: AWB fallback from filename → ' + filenameAwb);
      }
    }

    // Sanitise AWB: strip label prefixes, keep TBA intact
    if (extracted.awb) {
      extracted.awb = extracted.awb
        .replace(/^(DTr\s*:\s*|AWB\s*No\.?\s*:?\s*|AWB\s*:\s*|AWB\s+|Tracking\s*(?:No\.?\s*)?:\s*|Tracking\s*ID\s*:\s*|Consignment\s*(?:No\.?\s*)?:\s*)/i, '')
        .trim();
    }

    // Auto-assign courier + tracking URL
    extracted.courier  = COURIER_MAP[extracted.platform] || 'Unknown';
    extracted.trackUrl = getTrackingUrl(extracted.courier, extracted.awb, extracted.orderId);
    extracted.activeAI = activeAI;

    // Combine productName + productSKU into products field
    const pName = (extracted.productName || '').trim();
    const pSKU  = (extracted.productSKU  || extracted.products || '').trim();
    if (pName && pSKU && pName !== pSKU) {
      extracted.products = pName + ' | SKU: ' + pSKU;
    } else if (pName) {
      extracted.products = pName;
    } else if (pSKU) {
      extracted.products = pSKU;
    }
    delete extracted.productName;
    delete extracted.productSKU;

    // Ensure all fields exist
    ['invoiceDate','orderDate','billingAddress','buyerPhone','expectedDelivery','products',
     'shipDate','pincode','qty','amount','paymentType'].forEach(function(k) {
      if (!extracted[k]) extracted[k] = '';
    });
    if (!extracted.billingAddress && extracted.shippingAddress) {
      extracted.billingAddress = extracted.shippingAddress;
    }
    // Flipkart HBD/CPD date normalisation
    if (extracted.shipDate && extracted.shipDate.match(/^\d{2}\/\d{2}$/)) {
      var parts = extracted.shipDate.split('/');
      extracted.shipDate = parts[0] + '/' + parts[1] + '/' + new Date().getFullYear();
    }
    return extracted;
  });

  return respond({
    status: 'success',
    data: orders.length === 1 ? orders[0] : null,
    orders: orders,
    isMultiOrder: orders.length > 1,
    orderCount: orders.length
  });
}

/* ════════════════════════════════════════════════════════════
   ACTION: confirmPackage
   Receives confirmed/edited fields from user → track → save
════════════════════════════════════════════════════════════ */
function confirmPackage(e) {
  const p = e.parameter;
  const platform  = p.platform  || '';
  const courier   = p.courier   || COURIER_MAP[platform] || 'Unknown';
  const orderId   = collapseFkOrderId(p.orderId || '');  // Flipkart: drop any glued Invoice No
  const awb       = p.awb       || '';

  // Attempt live tracking on save; fall back to "Shipped" (neutral, honest) if APIs fail
  let tracking = { status: 'Shipped', statusDetail: 'Awaiting first scan.', lastLocation: '', lastEventTime: '' };
  try {
    if (awb) {
      const t = trackCourier(awb, courier, {
        shipDate: p.shipDate, orderDate: p.orderDate, savedOn: new Date(), courier: courier
      });
      if (t && t.status) {
        tracking = t; // use whatever real status the API returned
      }
      // if null: keep "Shipped" — accurate since PDF was just uploaded at dispatch time
    }
  } catch (err) {
    tracking.statusDetail = 'Tracking lookup error: ' + err.message;
  }

  const sheet    = getSheet();
  const now      = timestamp();

  // ── Duplicate detection — 4-tier lookup ──────────────────────
  // Tier 1: Invoice Number  — Amazon IN-XXX is globally unique per shipment.
  //                           Prevents dupes even when AWB differs between uploads.
  // Tier 2: AWB             — highly reliable when extraction was correct.
  // Tier 3: OrderID + empty AWB — CSV import placeholder row.
  // Tier 4: OrderID regardless  — last-resort catch-all.
  const invoiceNo = p.invoiceNumber || '';
  const existing  = (invoiceNo? findRowByInvoiceNo(sheet, invoiceNo)              : null)
                 || (awb     ? findRowByAWB(sheet, awb, invoiceNo)                 : null)
                 || (orderId  ? findRowByOrderId(sheet, orderId, true)            : null)
                 || (orderId  ? findRowByOrderId(sheet, orderId, false)           : null);

  Logger.log('confirmPackage: orderId=' + orderId + ' awb=' + awb + ' existing row=' + (existing||'none (new row)'));
  const trackUrl = getTrackingUrl(courier, awb, orderId);

  const row = [
    now,
    platform,
    courier,
    String(orderId || ''),
    String(awb     || ''),
    p.invoiceNumber    || '',
    toIsoDate(p.invoiceDate),
    toIsoDate(p.orderDate),
    p.buyerName        || '',
    p.buyerPhone       || '',
    p.shippingAddress  || '',
    p.billingAddress   || p.shippingAddress || '',
    p.pincode          || '',
    p.products         || '',
    p.qty              || '',
    p.amount           || '',
    p.paymentType      || '',
    toIsoDate(p.shipDate),
    toIsoDate(p.expectedDelivery),
    tracking.status    || 'Unknown',
    tracking.statusDetail || '',
    trackUrl,
    now
  ];

  if (existing) {
    // forceUpdate=true: PDF upload is authoritative — correct wrong AWB/Invoice in sheet
    mergeRow(sheet, existing, {
      platform: platform, courier: courier, orderId: orderId, awb: awb,
      invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate, orderDate: p.orderDate,
      buyerName: p.buyerName, buyerPhone: p.buyerPhone,
      shippingAddress: p.shippingAddress, billingAddress: p.billingAddress,
      pincode: p.pincode, products: p.products,
      qty: p.qty, amount: p.amount, paymentType: p.paymentType,
      shipDate: p.shipDate, expectedDelivery: p.expectedDelivery,
      status: tracking.status, statusDetail: tracking.statusDetail,
      trackUrl: trackUrl
    }, now, true); // ← forceUpdate = true
  } else {
    sheet.appendRow(row);
  }

  // Pre-register with TrackingMore so 📡 Track works immediately
  // (Delhivery + eKart need advance registration for API to start fetching)
  if (awb && (courier === 'Delhivery' || courier === 'eKart Logistics')) {
    try {
      const tmCode = courier === 'Delhivery' ? 'delhivery' : 'ekart';
      preRegisterWithTrackingMore([String(awb)], tmCode);
    } catch (e) { Logger.log('confirmPackage pre-register error: ' + e.message); }
  }

  return respond({
    status: 'success',
    data: {
      platform,
      courier,
      orderId,
      awb,
      invoiceNo:        p.invoiceNumber,
      invoiceDate:      p.invoiceDate,
      orderDate:        p.orderDate,
      buyerName:        p.buyerName,
      buyerPhone:       p.buyerPhone,
      shippingAddress:  p.shippingAddress,
      billingAddress:   p.billingAddress,
      pincode:          p.pincode,
      products:         p.products,
      qty:              p.qty,
      amount:           p.amount,
      payType:          p.paymentType,
      shipDate:         p.shipDate,
      expectedDelivery: p.expectedDelivery,
      trackingStatus:   tracking.status,
      statusDetail:     tracking.statusDetail,
      lastLocation:     tracking.lastLocation  || '',
      lastEventTime:    tracking.lastEventTime || '',
      trackUrl
    }
  });
}

/* ════════════════════════════════════════════════════════════
   ACTION: confirmBatch
   ─────────────────────────────────────────────────────────
   Saves all packages from one upload session in a SINGLE GAS
   execution, eliminating every reliability issue:

   Problem                        → Solution
   ─────────────────────────────────────────────────────────
   GAS cold-start kills calls 2+3 → 1 execution = 1 warmup
   Tracking API ×3 → timeout      → tracking SKIPPED in batch;
                                     default status = "Shipped"
                                     (correct at dispatch time)
   Duplicate from re-upload       → InvoiceNo checked FIRST;
                                     sheet read ONCE; LockService
                                     prevents race conditions;
                                     flush() makes writes visible
   Same AWB for different orders  → duplicate AWB detector warns user
   ERP not updating               → notifyERP() fires after save
   ─────────────────────────────────────────────────────────
   Input  : e.parameter.packages = JSON.stringify([...])
   Returns: { status:'success', results:[], saved:N, errors:N,
              warnings:[] }
════════════════════════════════════════════════════════════ */
function confirmBatch(e) {
  var packagesJson = e.parameter.packages;
  if (!packagesJson) return respond({ status:'error', message:'No packages data.' });

  var packages;
  try { packages = JSON.parse(packagesJson); }
  catch (err) { return respond({ status:'error', message:'Invalid JSON: ' + err.message }); }

  if (!Array.isArray(packages) || !packages.length)
    return respond({ status:'error', message:'packages must be a non-empty array.' });

  // Lock: prevents two simultaneous saves racing each other
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (lerr) { return respond({ status:'error', message:'Server busy — retry in a moment.' }); }

  try {
    var sheet = getSheet();
    var now   = timestamp();

    // Flush any in-flight writes, then read the sheet ONCE into memory.
    // All dedup lookups use this array. After each save it is updated so
    // intra-batch duplicates are impossible even at Sheets eventual consistency.
    SpreadsheetApp.flush();
    var sheetData = sheet.getDataRange().getValues(); // [0] = header row

    var results  = [];
    var warnings = [];                // duplicate AWB warnings shown to user

    // ── Intra-batch duplicate AWB detector ──────────────────────
    // If two packages in this batch share an AWB but have different
    // Invoice Numbers, the AI likely confused the PDFs.
    var batchAWBmap = {}; // awb → invoiceNo of first occurrence
    packages.forEach(function(p) {
      var awb = String(p.awb || '').trim();
      var inv = String(p.invoiceNumber || '').trim();
      if (awb && inv) {
        if (batchAWBmap[awb] && batchAWBmap[awb] !== inv) {
          warnings.push('⚠️  AWB ' + awb + ' was assigned to both Invoice '
            + batchAWBmap[awb] + ' and ' + inv
            + ' — the AI may have confused two PDFs. Please verify and correct the AWB manually.');
          Logger.log('confirmBatch WARNING: duplicate AWB ' + awb
            + ' on invoices ' + batchAWBmap[awb] + ' and ' + inv);
        } else {
          batchAWBmap[awb] = inv;
        }
      }
    });

    for (var pi = 0; pi < packages.length; pi++) {
      var p        = packages[pi];
      var platform = p.platform  || '';
      var courier  = p.courier   || COURIER_MAP[platform] || 'Unknown';
      var orderId  = collapseFkOrderId(String(p.orderId || ''));  // Flipkart: drop any glued Invoice No
      var awb      = String(p.awb            || '');
      var invoiceNo = String(p.invoiceNumber || '');

      if (!awb && !orderId && !invoiceNo) {
        results.push({ status:'error', orderId:orderId, awb:awb,
                       message:'Order ID, AWB, and Invoice Number all empty — skipped.' });
        continue;
      }

      try {
        // Tracking skipped in batch — see reason in function header above
        var tracking = { status:'Shipped',
                         statusDetail:'Dispatched. Tap \uD83D\uDCE1 Re-track for live status.',
                         lastLocation:'', lastEventTime:'' };
        var trackUrl = getTrackingUrl(courier, awb, orderId);

        // Dedup — InvoiceNo checked FIRST (Amazon IN-XXX is globally unique)
        var existingRowNum = findInMemoryRow(sheetData, invoiceNo, awb, orderId);

        var rowArray = [
          now, platform, courier, orderId, awb, invoiceNo,
          toIsoDate(p.invoiceDate), toIsoDate(p.orderDate),
          p.buyerName || '', p.buyerPhone || '',
          p.shippingAddress || '',
          p.billingAddress  || p.shippingAddress || '',
          p.pincode || '', p.products || '',
          p.qty || '', p.amount || '', p.paymentType || 'COD',
          toIsoDate(p.shipDate), toIsoDate(p.expectedDelivery),
          tracking.status, tracking.statusDetail, trackUrl, now
        ];

        if (existingRowNum !== null) {
          mergeRow(sheet, existingRowNum, {
            platform:platform, courier:courier, orderId:orderId, awb:awb,
            invoiceNumber:invoiceNo, invoiceDate:p.invoiceDate,
            orderDate:p.orderDate, buyerName:p.buyerName,
            buyerPhone:p.buyerPhone, shippingAddress:p.shippingAddress,
            billingAddress:p.billingAddress || p.shippingAddress,
            pincode:p.pincode, products:p.products,
            qty:p.qty, amount:p.amount, paymentType:p.paymentType,
            shipDate:p.shipDate, expectedDelivery:p.expectedDelivery,
            status:tracking.status, statusDetail:tracking.statusDetail,
            trackUrl:trackUrl
          }, now, true);  // forceUpdate=true: PDF is authoritative
          sheetData[existingRowNum - 1] = rowArray;
          Logger.log('confirmBatch[' + pi + ']: UPDATED row ' + existingRowNum
                     + ' inv=' + invoiceNo + ' orderId=' + orderId);
        } else {
          sheet.appendRow(rowArray);
          SpreadsheetApp.flush();     // commit before next iteration's dedup read
          sheetData.push(rowArray);
          Logger.log('confirmBatch[' + pi + ']: NEW ROW inv=' + invoiceNo + ' orderId=' + orderId);
        }

        // Pre-register with TrackingMore (fast; non-blocking for Delhivery/eKart)
        if (awb && (courier === 'Delhivery' || courier === 'eKart Logistics')) {
          try {
            preRegisterWithTrackingMore([String(awb)],
              courier === 'Delhivery' ? 'delhivery' : 'ekart');
          } catch(rerr) { Logger.log('confirmBatch preRegister: ' + rerr.message); }
        }

        results.push({
          status:'success', orderId:orderId, awb:awb, invoiceNo:invoiceNo,
          platform:platform, courier:courier, trackUrl:trackUrl,
          trackingStatus:tracking.status, statusDetail:tracking.statusDetail,
          _pkg:p
        });

      } catch (perr) {
        Logger.log('confirmBatch[' + pi + '] ERROR inv=' + invoiceNo + ': ' + perr);
        results.push({ status:'error', orderId:orderId, awb:awb, invoiceNo:invoiceNo,
                       message:perr.toString() });
      }
    }

    var saved  = results.filter(function(r){ return r.status === 'success'; }).length;
    var errors = results.filter(function(r){ return r.status === 'error';   }).length;
    Logger.log('confirmBatch: ' + saved + ' saved, ' + errors + ' error(s), '
               + warnings.length + ' warning(s)');

    if (saved > 0) {
      try { notifyERP(results); } catch(nerr) { Logger.log('notifyERP: ' + nerr.message); }
    }

    return respond({
      status:'success', results:results, saved:saved, errors:errors,
      warnings:warnings,
      message:saved + ' of ' + packages.length + ' package(s) saved.'
              + (warnings.length ? ' ' + warnings.length + ' warning(s) — check AWBs.' : '')
    });

  } finally {
    lock.releaseLock();
  }
}

/* ════════════════════════════════════════════════════════════
   findInMemoryRow
   ─────────────────────────────────────────────────────────
   4-tier dedup on the pre-loaded sheet data array (no extra
   sheet reads). InvoiceNo is Tier 1 because Amazon IN-XXX is
   globally unique per shipment — prevents duplicates even when
   the AI extracts a different AWB on repeated uploads.

   Tier order:
     1. InvoiceNo  — Amazon IN-XXX never changes; uniquely identifies
                     a shipment regardless of AWB extraction accuracy.
     2. AWB        — reliable when extraction was correct.
     3. OrderID + empty AWB — CSV import placeholder row.
     4. OrderID regardless  — last-resort catch-all.

   data[0] = header row; loop starts at i=1 (first data row).
   Returns 1-based sheet row number, or null for new row.
════════════════════════════════════════════════════════════ */
function findInMemoryRow(data, invoiceNo, awb, orderId) {
  var normINV = normaliseId(invoiceNo);
  var normAWB = normaliseId(awb);
  var normOID = normaliseId(orderId);
  var i;

  // Tier 1: Invoice Number — primary key for Amazon (IN-XXX format)
  if (normINV) {
    for (i = 1; i < data.length; i++) {
      if (normaliseId(String(data[i][C.INVOICE_NO - 1] || '')) === normINV) {
        Logger.log('findInMemoryRow TIER-1 InvoiceNo match row ' + (i+1) + ' inv=' + normINV);
        return i + 1;
      }
    }
  }

  // Tier 2: AWB — unique per physical shipment when extraction is correct.
  // Safety: if both the incoming InvoiceNo and the existing row's InvoiceNo
  // are non-empty and DIFFERENT, the AI assigned the same AWB to two different
  // orders (a known confusion pattern). Skip — treat the incoming order as new.
  if (normAWB) {
    for (i = 1; i < data.length; i++) {
      if (normaliseId(String(data[i][C.AWB - 1] || '')) === normAWB) {
        var existingInvT2 = normaliseId(String(data[i][C.INVOICE_NO - 1] || ''));
        if (normINV && existingInvT2 && normINV !== existingInvT2) {
          Logger.log('findInMemoryRow TIER-2 SKIP: AWB collision — incoming inv='
            + normINV + ' existing inv=' + existingInvT2 + ' awb=' + normAWB);
          continue; // different invoice — do NOT match on AWB
        }
        Logger.log('findInMemoryRow TIER-2 AWB match row ' + (i+1) + ' awb=' + normAWB);
        return i + 1;
      }
    }
  }

  // Tier 3: OrderID with empty AWB (CSV import placeholder)
  if (normOID) {
    for (i = 1; i < data.length; i++) {
      if (normaliseId(String(data[i][C.ORDER_ID - 1] || '')) === normOID) {
        if (!String(data[i][C.AWB - 1] || '').trim()) {
          Logger.log('findInMemoryRow TIER-3 OrderID+emptyAWB match row ' + (i+1));
          return i + 1;
        }
      }
    }
  }

  // Tier 4: OrderID regardless (catch-all)
  if (normOID) {
    for (i = 1; i < data.length; i++) {
      if (normaliseId(String(data[i][C.ORDER_ID - 1] || '')) === normOID) {
        Logger.log('findInMemoryRow TIER-4 OrderID match row ' + (i+1));
        return i + 1;
      }
    }
  }

  return null;  // genuinely new row
}

/* ════════════════════════════════════════════════════════════
   notifyERP
   Sends saved orders to the ERP backend immediately after
   confirmBatch, eliminating the 5-minute polling delay.
   Failure is silent — never blocks the Package Tracker response.
════════════════════════════════════════════════════════════ */
function notifyERP(results) {
  var erpUrl = 'https://script.google.com/macros/s/AKfycbxlwJl2rFejvbdGMJ8en6_TOOfJYmuD2EDcFXAvY4uxErD8w382nIxecxhHGFVgFM_9/exec';
  var orders = results
    .filter(function(r){ return r.status === 'success' && r._pkg; })
    .map(function(r){
      var p = r._pkg;
      return {
        orderId:r.orderId, awb:r.awb, invoiceNumber:r.invoiceNo||'',
        platform:r.platform, courier:r.courier, trackUrl:r.trackUrl,
        trackingStatus:r.trackingStatus,
        invoiceDate:toIsoDate(p.invoiceDate), orderDate:toIsoDate(p.orderDate),
        shipDate:toIsoDate(p.shipDate), expectedDelivery:toIsoDate(p.expectedDelivery),
        buyerName:String(p.buyerName||''), buyerPhone:String(p.buyerPhone||''),
        shippingAddress:String(p.shippingAddress||''),
        billingAddress:String(p.billingAddress||p.shippingAddress||''),
        pincode:String(p.pincode||''), products:String(p.products||''),
        qty:String(p.qty||''), amount:String(p.amount||''),
        paymentType:String(p.paymentType||'COD')
      };
    });
  if (!orders.length) return;
  UrlFetchApp.fetch(erpUrl, {
    method:'POST', contentType:'text/plain;charset=utf-8',
    payload:JSON.stringify({ action:'addTrackerOrders', orders:orders }),
    muteHttpExceptions:true, followRedirects:true
  });
  Logger.log('notifyERP: sent ' + orders.length + ' order(s)');
}

/* ════════════════════════════════════════════════════════════
   ACTION: deduplicateSheet
   Removes duplicate rows, keeping the most-complete row per group.
   Group key = InvoiceNo (primary) → AWB → OrderID.
   Run once from the GAS editor to clean up existing dupes,
   or call via the frontend "Remove Duplicates" button.
════════════════════════════════════════════════════════════ */
function deduplicateSheet() {
  var sheet   = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 2) return respond({ status:'success', message:'Nothing to deduplicate.', removed:0 });

  var data   = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var groups = {};

  for (var i = 0; i < data.length; i++) {
    var inv = normaliseId(String(data[i][C.INVOICE_NO  - 1] || ''));
    var awb = normaliseId(String(data[i][C.AWB          - 1] || ''));
    var oid = normaliseId(String(data[i][C.ORDER_ID     - 1] || ''));
    var key = (inv && inv.length > 2 ? inv : null) || awb || oid;
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ sheetRow: i + 2, row: data[i] });
  }

  var toDelete = [];
  Object.keys(groups).forEach(function(key) {
    var grp = groups[key];
    if (grp.length <= 1) return;
    grp.sort(function(a, b) {
      var sa = a.row.filter(function(v){ return v !== '' && v !== null && v !== undefined; }).length;
      var sb = b.row.filter(function(v){ return v !== '' && v !== null && v !== undefined; }).length;
      return sb - sa;
    });
    for (var j = 1; j < grp.length; j++) toDelete.push(grp[j].sheetRow);
  });

  if (!toDelete.length) return respond({ status:'success', message:'No duplicates found — sheet is clean.', removed:0 });

  toDelete.sort(function(a, b){ return b - a; });  // bottom-to-top
  toDelete.forEach(function(rn){ sheet.deleteRow(rn); });
  Logger.log('deduplicateSheet: removed ' + toDelete.length + ' duplicate row(s)');
  return respond({ status:'success', removed:toDelete.length,
                   message:'Removed ' + toDelete.length + ' duplicate row(s). Sheet is now clean.' });
}

/* ════════════════════════════════════════════════════════════
   ACTION: organizeSheets
   ─────────────────────────────────────────────────────────
   Organises the Google Spreadsheet into:
     • Package Tracker  — Master tab (all orders, never deleted)
     • May 2026         — Copy of orders with Invoice Date in May 2026
     • Apr 2026         — Copy of orders with Invoice Date in Apr 2026
     • Mar 2026         — etc.
     • No Date          — Orders with no readable Invoice Date

   Within every tab (including Master) rows are sorted by
   Invoice Date ascending, then by Invoice Number (natural sort).

   Design:
   • Master is the single source of truth. Monthly tabs are
     READ-ONLY views generated from Master data. They are fully
     rebuilt every time this action runs — never edit them
     directly; edit Master instead.
   • Called by the frontend "📅 Organise Sheets" button.
   • Also called after every confirmBatch save so the sheet
     stays organised automatically.
════════════════════════════════════════════════════════════ */
function organizeSheets() {
  var ss     = SpreadsheetApp.openById(SHEET_ID);
  var master = getSheet();
  var lastRow = master.getLastRow();

  if (lastRow <= 1) return respond({ status:'success', message:'No data to organise.' });

  var allData = master.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* ── Helper: parse "DD/MM/YYYY" → Date object for sorting ── */
  function parseInvDate(val) {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val.getTime())) return val;
    var s = String(val).trim();
    var m;
    // DD/MM/YYYY
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);
    // YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return new Date(+m[1], +m[2]-1, +m[3]);
    // DD.MM.YYYY
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);
    return null;
  }

  /* ── Helper: parse "DD/MM/YYYY" → "May 2026" tab name ── */
  function dateToMonthKey(val) {
    var d = parseInvDate(val);
    if (!d || isNaN(d.getTime())) return null;
    var yr = d.getFullYear();
    if (yr < 2020 || yr > 2099) return null;
    return MONTHS[d.getMonth()] + ' ' + yr;
  }

  /* ── Sort comparator: Invoice Date ASC, then Invoice No natural ── */
  function rowSortCmp(a, b) {
    var da = parseInvDate(a[C.INVOICE_DATE - 1]);
    var db = parseInvDate(b[C.INVOICE_DATE - 1]);
    var ta = da ? da.getTime() : Infinity;
    var tb = db ? db.getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return naturalCompare(
      String(a[C.INVOICE_NO - 1] || ''),
      String(b[C.INVOICE_NO - 1] || '')
    );
  }

  /* ── Step 1: Sort Master by Invoice Date ── */
  allData.sort(rowSortCmp);
  master.getRange(2, 1, allData.length, HEADERS.length).setValues(allData);
  Logger.log('organizeSheets: Master sorted (' + allData.length + ' rows)');

  /* ── Step 2: Group rows by Invoice Date month ── */
  var monthMap = {};  // { 'May 2026': [row, ...] }
  var noDateRows = [];

  allData.forEach(function(row) {
    var key = dateToMonthKey(row[C.INVOICE_DATE - 1]);
    if (key) {
      if (!monthMap[key]) monthMap[key] = [];
      monthMap[key].push(row);
    } else {
      noDateRows.push(row);
    }
  });

  /* ── Step 3: Build list of month keys, newest first ── */
  var monthKeys = Object.keys(monthMap);
  monthKeys.sort(function(a, b) {
    var parse = function(k) {
      var p = k.split(' ');
      return parseInt(p[1],10) * 12 + MONTHS.indexOf(p[0]);
    };
    return parse(b) - parse(a);  // newest first
  });

  /* ── Step 4: Write / update each monthly tab ── */
  var TAB_COLORS = ['#1a6ca8','#1d7a4a','#a04000','#7d3c98',
                    '#b7950b','#117a65','#922b21','#515a5a'];
  var created = 0, updated = 0;

  function writeTab(tabName, rows, tabColor) {
    // Delete legacy "Unknown" tab if present
    var old = ss.getSheetByName('Unknown');
    if (old) { try { ss.deleteSheet(old); } catch(e) {} }

    var tab = ss.getSheetByName(tabName);
    if (!tab) { tab = ss.insertSheet(tabName); created++; }
    else       { tab.clearContents(); updated++; }

    // Header
    tab.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    var hdr = tab.getRange(1, 1, 1, HEADERS.length);
    hdr.setBackground('#0D1B2A');
    hdr.setFontColor('#00D4F0');
    hdr.setFontWeight('bold');
    hdr.setFontSize(10);
    tab.setFrozenRows(1);

    // Data rows (already sorted)
    if (rows.length > 0)
      tab.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);

    // Column widths (mirror Master)
    tab.setColumnWidth(C.PRODUCTS,    380);
    tab.setColumnWidth(C.SHIP_ADDR,   260);
    tab.setColumnWidth(C.BILL_ADDR,   260);
    tab.setColumnWidth(C.STATUS_DTL,  220);
    tab.setColumnWidth(C.TRACK_URL,   200);
    tab.setColumnWidth(C.INVOICE_DATE,120);
    tab.setColumnWidth(C.ORDER_DATE,  120);
    tab.setColumnWidth(C.SHIP_DATE,   120);
    tab.setColumnWidth(C.EXP_DEL,     120);

    // Text format on ID columns
    tab.getRange(1, C.ORDER_ID,  tab.getMaxRows(), 1).setNumberFormat('@STRING@');
    tab.getRange(1, C.AWB,       tab.getMaxRows(), 1).setNumberFormat('@STRING@');
    tab.getRange(1, C.INVOICE_NO,tab.getMaxRows(), 1).setNumberFormat('@STRING@');
    tab.getRange(1, C.BUYER_PHONE,tab.getMaxRows(),1).setNumberFormat('@STRING@');
    tab.getRange(1, C.PINCODE,   tab.getMaxRows(), 1).setNumberFormat('@STRING@');

    tab.setTabColor(tabColor);

    // Note on A1 shows row count and generation time
    tab.getRange(1, 1).setNote(rows.length + ' orders · Invoice Date sorted · '
      + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM yyyy HH:mm'));
  }

  monthKeys.forEach(function(key, idx) {
    writeTab(key, monthMap[key], TAB_COLORS[idx % TAB_COLORS.length]);
    Logger.log('organizeSheets: tab "' + key + '" → ' + monthMap[key].length + ' rows');
  });

  if (noDateRows.length > 0) {
    writeTab('No Date', noDateRows, '#888888');
    Logger.log('organizeSheets: "No Date" → ' + noDateRows.length + ' rows');
  } else {
    // Remove old "No Date" tab if it exists and is now empty
    var ndTab = ss.getSheetByName('No Date');
    if (ndTab) { try { ss.deleteSheet(ndTab); } catch(e) {} }
  }

  /* ── Step 5: Reorder tabs  ─────────────────────────────────
     Layout: [Master] [May 2026] [Apr 2026] ... [No Date]     */
  ss.setActiveSheet(master);
  ss.moveActiveSheet(1);
  monthKeys.forEach(function(key, idx) {
    var t = ss.getSheetByName(key);
    if (t) { ss.setActiveSheet(t); ss.moveActiveSheet(idx + 2); }
  });
  if (noDateRows.length > 0) {
    var nd = ss.getSheetByName('No Date');
    if (nd) { ss.setActiveSheet(nd); ss.moveActiveSheet(monthKeys.length + 2); }
  }
  ss.setActiveSheet(master); // return focus to Master

  return respond({
    status:  'success',
    created:  created,
    updated:  updated,
    months:   monthKeys.length,
    noDate:   noDateRows.length,
    message:  'Master sorted by Invoice Date. '
              + monthKeys.length + ' monthly tab(s) rebuilt'
              + (noDateRows.length ? '; ' + noDateRows.length + ' rows in "No Date".' : '.')
  });
}

/* ════════════════════════════════════════════════════════════
   ACTION: reTrack — update one row in-place
════════════════════════════════════════════════════════════ */
function reTrack(e) {
  const rowIndex = parseInt(e.parameter.rowIndex, 10);
  if (!rowIndex || rowIndex < 2) return respond({ status: 'error', message: 'Invalid row.' });

  const sheet   = getSheet();
  const row     = sheet.getRange(rowIndex, 1, 1, HEADERS.length).getValues()[0];
  const awb     = String(row[C.AWB     - 1] || '').trim();
  const courier = String(row[C.COURIER - 1] || '').trim();

  if (!awb) return respond({ status: 'error', message: 'No AWB in this row.' });

  const existingStatus = String(row[C.STATUS - 1] || '').trim();
  const shipDate       = String(row[C.SHIP_DATE - 1] || '').trim();
  const orderDate      = String(row[C.ORDER_DATE - 1] || '').trim();

  let newStatus      = existingStatus;
  let newStatusDetail= '';

  try {
    const result = trackCourier(awb, courier, {
      shipDate: shipDate, orderDate: orderDate, savedOn: String(row[C.SAVED_ON - 1] || ''), courier: courier
    });
    if (result && result.status) {
      newStatus       = result.status;
      newStatusDetail = result.statusDetail || '';
    } else {
      // API returned null — apply age-based estimate
      const ageEst = estimateStatusByAge(shipDate, orderDate, existingStatus);
      if (ageEst) {
        newStatus       = ageEst.status;
        newStatusDetail = ageEst.statusDetail;
      } else {
        // Keep existing status; clear stale generic messages
        newStatus = existingStatus || 'In Transit';
        const stale = ['Package in transit. Use Track button', 'Auto-tracking unavailable',
                       'Awaiting first scan', 'Imported from report'];
        const curDetail = String(row[C.STATUS_DTL - 1] || '');
        newStatusDetail = stale.some(function(s){ return curDetail.includes(s); })
                        ? 'Live tracking unavailable. Try 🔄 Retrack or check courier portal.'
                        : curDetail;
      }
    }
  } catch (err) {
    newStatusDetail = 'Tracking error: ' + err.message;
  }

  const now = timestamp();
  const orderId = String(row[C.ORDER_ID - 1] || '').trim();
  sheet.getRange(rowIndex, C.STATUS      ).setValue(newStatus);
  sheet.getRange(rowIndex, C.STATUS_DTL  ).setValue(newStatusDetail);
  sheet.getRange(rowIndex, C.LAST_TRACKED).setValue(now);

  // Update Tracking URL to status-specific page (especially useful for eKart/Flipkart)
  const newTrackUrl = getTrackingUrl(courier, awb, orderId, newStatus);
  if (newTrackUrl) sheet.getRange(rowIndex, C.TRACK_URL).setValue(newTrackUrl);

  return respond({ status: 'success', data: { status: newStatus, lastTracked: now, trackUrl: newTrackUrl } });
}

/* ════════════════════════════════════════════════════════════
   ACTION: reTrackAll
════════════════════════════════════════════════════════════ */
function reTrackAll() {
  const sheet = getSheet();
  const data  = sheet.getDataRange().getValues();
  const start = Date.now();
  const BUDGET_MS = 4.5 * 60 * 1000; // stay safely under the 6-min execution cap
  let updated = 0, remaining = 0;

  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status  = row[C.STATUS  - 1];
    const awb     = row[C.AWB     - 1];
    const courier = row[C.COURIER - 1];
    if (!awb || FINAL_STATUSES.includes(status)) continue;
    if (Date.now() - start > BUDGET_MS) { remaining++; continue; } // out of time — leave for next run
    try {
      const t = trackCourier(awb, courier, {
        shipDate:  row[C.SHIP_DATE  - 1],
        orderDate: row[C.ORDER_DATE - 1],
        savedOn:   row[C.SAVED_ON   - 1],
        courier:   courier
      });
      if (!t || !t.status) continue;   // all APIs failed — keep existing status
      const now = timestamp();
      sheet.getRange(i+1, C.STATUS      ).setValue(t.status      || '');
      sheet.getRange(i+1, C.STATUS_DTL  ).setValue(t.statusDetail|| '');
      sheet.getRange(i+1, C.LAST_TRACKED).setValue(now);
      updated++;
      Utilities.sleep(300);
    } catch(err) { Logger.log('reTrackAll row '+(i+1)+': '+err.message); }
  }
  return respond({ status:'success', updated, remaining });
}

/* ════════════════════════════════════════════════════════════
   ACTION: loadPackages
════════════════════════════════════════════════════════════ */
function loadPackages() {
  const sheet = getSheet();
  const data  = sheet.getDataRange().getValues();
  const packages = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[C.AWB-1] && !r[C.ORDER_ID-1]) continue;
    packages.push({
      rowIndex:        i + 1,
      savedOn:         r[C.SAVED_ON    -1],
      platform:        r[C.PLATFORM    -1],
      courier:         r[C.COURIER     -1],
      orderId:         r[C.ORDER_ID    -1],
      awb:             r[C.AWB         -1],
      invoiceNo:       r[C.INVOICE_NO   -1],
      invoiceDate:     r[C.INVOICE_DATE -1],
      orderDate:       r[C.ORDER_DATE   -1],
      buyerName:       r[C.BUYER_NAME   -1],
      buyerPhone:      r[C.BUYER_PHONE  -1],
      shippingAddress: r[C.SHIP_ADDR    -1],
      billingAddress:  r[C.BILL_ADDR    -1],
      pincode:         r[C.PINCODE      -1],
      products:        r[C.PRODUCTS    -1],
      qty:             r[C.QTY         -1],
      amount:          r[C.AMOUNT      -1],
      payType:         r[C.PAY_TYPE    -1],
      shipDate:        r[C.SHIP_DATE   -1],
      expectedDelivery:r[C.EXP_DEL    -1],
      status:          r[C.STATUS      -1],
      statusDetail:    r[C.STATUS_DTL  -1],
      trackingUrl:     r[C.TRACK_URL   -1],
      lastTracked:     r[C.LAST_TRACKED-1]
    });
  }

  packages.reverse();
  return respond({ status:'success', data: packages });
}

/* ════════════════════════════════════════════════════════════
   ACTION: getSettings
════════════════════════════════════════════════════════════ */
function getSettings() {
  const p = PropertiesService.getScriptProperties();
  return respond({
    activeAI:       p.getProperty('ACTIVE_AI')        || 'gemini',
    geminiKeySet:   !!p.getProperty('GEMINI_API_KEY'),
    openaiKeySet:   !!p.getProperty('OPENAI_API_KEY'),
    claudeKeySet:   !!p.getProperty('CLAUDE_API_KEY'),
    deepseekKeySet: !!p.getProperty('DEEPSEEK_API_KEY'),
    track17KeySet:      !!p.getProperty('TRACK17_API_KEY'),
    shiprocketKeySet:   !!(p.getProperty('SHIPROCKET_EMAIL') && p.getProperty('SHIPROCKET_PASS')),
    delhiveryKeySet:    !!p.getProperty('DELHIVERY_API_KEY'),
    aftershipKeySet:    !!(p.getProperty('TRACKINGMORE_API_KEY') || p.getProperty('AFTERSHIP_API_KEY'))
  });
}

/* ════════════════════════════════════════════════════════════
   ACTION: saveSettings
════════════════════════════════════════════════════════════ */
function saveSettings(e) {
  const p = PropertiesService.getScriptProperties();
  let changed = [];
  if (e.parameter.activeAI   && e.parameter.activeAI.length   > 0) { p.setProperty('ACTIVE_AI',        e.parameter.activeAI);   changed.push('activeAI'); }
  if (e.parameter.geminiKey  && e.parameter.geminiKey.length  > 0) { p.setProperty('GEMINI_API_KEY',   e.parameter.geminiKey);  changed.push('geminiKey'); }
  if (e.parameter.openaiKey  && e.parameter.openaiKey.length  > 0) { p.setProperty('OPENAI_API_KEY',   e.parameter.openaiKey);  changed.push('openaiKey'); }
  if (e.parameter.claudeKey  && e.parameter.claudeKey.length  > 0) { p.setProperty('CLAUDE_API_KEY',   e.parameter.claudeKey);  changed.push('claudeKey'); }
  if (e.parameter.deepseekKey && e.parameter.deepseekKey.length > 0) { p.setProperty('DEEPSEEK_API_KEY', e.parameter.deepseekKey); changed.push('deepseekKey'); }
  if (e.parameter.track17Key      && e.parameter.track17Key.length      > 0) { p.setProperty('TRACK17_API_KEY',   e.parameter.track17Key);      changed.push('track17Key'); }
  if (e.parameter.aftershipKey && e.parameter.aftershipKey.length > 0) { p.setProperty('TRACKINGMORE_API_KEY', e.parameter.aftershipKey); p.setProperty('AFTERSHIP_API_KEY', e.parameter.aftershipKey); changed.push('aftershipKey'); }
  if (e.parameter.delhiveryKey    && e.parameter.delhiveryKey.length    > 0) { p.setProperty('DELHIVERY_API_KEY', e.parameter.delhiveryKey);    changed.push('delhiveryKey'); }
  if (e.parameter.shiprocketEmail && e.parameter.shiprocketEmail.length > 0) { p.setProperty('SHIPROCKET_EMAIL', e.parameter.shiprocketEmail); changed.push('shiprocketEmail'); }
  if (e.parameter.shiprocketPass  && e.parameter.shiprocketPass.length  > 0) { p.setProperty('SHIPROCKET_PASS',  e.parameter.shiprocketPass);  changed.push('shiprocketPass'); }
  if (changed.length === 0) return respond({ status:'error', message:'Nothing to save.' });
  return respond({ status:'success', message:'Saved: '+changed.join(', ') });
}


/* ════════════════════════════════════════════════════════════
   ACTION: fixTrackingUrls — update all broken Delhivery URLs in sheet
════════════════════════════════════════════════════════════ */
function fixTrackingUrls() {
  const sheet   = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return respond({ status:'success', fixed: 0 });

  const data    = sheet.getDataRange().getValues();
  let fixed = 0;

  for (let i = 1; i < data.length; i++) {
    const courier  = String(data[i][C.COURIER    - 1] || '');
    const awb      = String(data[i][C.AWB        - 1] || '').trim();
    const orderId  = String(data[i][C.ORDER_ID   - 1] || '').trim();
    const oldUrl   = String(data[i][C.TRACK_URL  - 1] || '');

    // Regenerate the correct URL for this courier/AWB
    const newUrl = getTrackingUrl(courier, awb, orderId);

    // Fix conditions — only clear genuinely broken URLs:
    // 1. Old track.delhivery.com/p/ (auth-required, broken)
    // 2. Old internal tracking/?AWB format
    // 3. ekartlogistics.com (blank SPA)
    // 4. seller.flipkart.com/ root (was wrong, now using #dashboard/my-orders)
    // 5. delhivery.com/track/p/ variant
    // NOTE: delhivery.com/track-v2/package/ is VALID — do NOT clear it
    const isBroken =
      oldUrl.includes('track.delhivery.com/p')        ||   // auth-required, broken
      oldUrl.includes('delhivery.com/p/')              ||   // old broken variant
      oldUrl.includes('tracking/?AWB')                 ||   // old IBI internal format
      oldUrl === 'https://www.delhivery.com/track/p/'  ||   // wrong path variant
      (oldUrl === 'https://seller.flipkart.com/');          // old root URL → update to hash route

    if (isBroken && oldUrl !== newUrl) {
      sheet.getRange(i + 1, C.TRACK_URL).setValue(newUrl);
      fixed++;
    } else if (oldUrl === '' && newUrl !== '') {
      // Fill in missing URL
      sheet.getRange(i + 1, C.TRACK_URL).setValue(newUrl);
      fixed++;
    }
  }

  return respond({ status: 'success', fixed: fixed, message: 'Fixed ' + fixed + ' tracking URLs.' });
}

/* ════════════════════════════════════════════════════════════
   ACTION: clearAllPackages — delete all data rows from sheet
════════════════════════════════════════════════════════════ */
function clearAllPackages() {
  const sheet    = getSheet();
  const lastRow  = sheet.getLastRow();
  if (lastRow <= 1) return respond({ status:'success', message:'Sheet is already empty.' });
  sheet.deleteRows(2, lastRow - 1);
  return respond({ status:'success', message:'All packages cleared.' });
}

/* ════════════════════════════════════════════════════════════
   ACTION: cleanStaleData
   One-click cleanup of stale/wrong data in the Sheet:
   1. Removes broken tracking URLs (delhivery.com, ekartlogistics.com)
   2. Replaces stale status detail messages with neutral ones
   3. Fixes rows with status "Unknown" that have ship date < 8 days
      (they should just say "In Transit" not "Unknown")
   4. Blanks out the STATUS_DTL for rows with generic boilerplate
════════════════════════════════════════════════════════════ */
function cleanStaleData() {
  const sheet   = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return respond({ status: 'success', cleaned: 0, urlsFixed: 0 });

  const data    = sheet.getDataRange().getValues();
  let cleaned   = 0;
  let urlsFixed = 0;

  // Stale boilerplate messages to replace
  const STALE_DETAILS = [
    'Package in transit. Use Track button for live status.',
    'Package in transit. Use Track button',
    'Auto-tracking unavailable. Use the tracking link or Retrack button.',
    'Auto-tracking unavailable',
    'Awaiting first scan.',
    'Imported from report',
    'Package shipped. Click tracking link for live status.',
    'Live tracking pending. Check via tracking link.',
    'Tracking data not yet available'
  ];

  for (let i = 1; i < data.length; i++) {
    const rowNum  = i + 1;
    const courier = String(data[i][C.COURIER    - 1] || '');
    const awb     = String(data[i][C.AWB        - 1] || '').trim();
    const orderId = String(data[i][C.ORDER_ID   - 1] || '').trim();
    const detail  = String(data[i][C.STATUS_DTL - 1] || '').trim();
    const oldUrl  = String(data[i][C.TRACK_URL  - 1] || '');
    const status  = String(data[i][C.STATUS     - 1] || '').trim();

    // ── Fix tracking URLs ─────────────────────────────────
    const correctUrl = getTrackingUrl(courier, awb, orderId);
    const brokenUrl  =
      oldUrl.includes('ekartlogistics.com')          ||   // blank SPA
      oldUrl.includes('track.delhivery.com/p')       ||   // auth required
      oldUrl.includes('tracking/?AWB')               ||   // old IBI format
      oldUrl === 'https://seller.flipkart.com/';          // old root without hash route
    // Note: delhivery.com/track-v2/package/ is VALID — do NOT clear it
    if (brokenUrl && oldUrl !== correctUrl) {
      sheet.getRange(rowNum, C.TRACK_URL).setValue(correctUrl);
      urlsFixed++;
    } else if (oldUrl === '' && correctUrl !== '') {
      sheet.getRange(rowNum, C.TRACK_URL).setValue(correctUrl);
      urlsFixed++;
    }

    // ── Clean stale status detail messages ────────────────
    const isStale = STALE_DETAILS.some(function(s) {
      return detail.toLowerCase().includes(s.toLowerCase());
    });
    if (isStale) {
      sheet.getRange(rowNum, C.STATUS_DTL).setValue('');
      cleaned++;
    }

    // ── Fix "Unknown" for very recent shipments ───────────
    // If ship date < 8 days ago and status is Unknown,
    // it was falsely set by an expired TrackingMore key — reset to In Transit
    if (status === 'Unknown') {
      const shipDate  = String(data[i][C.SHIP_DATE  - 1] || '').trim();
      const orderDate = String(data[i][C.ORDER_DATE - 1] || '').trim();
      var refDate = null;
      var ds = shipDate || orderDate;
      if (ds) {
        var m = ds.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) refDate = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
      }
      if (refDate) {
        var age = Math.floor((Date.now() - refDate.getTime()) / 86400000);
        if (age >= 0 && age <= 8) {
          sheet.getRange(rowNum, C.STATUS    ).setValue('In Transit');
          sheet.getRange(rowNum, C.STATUS_DTL).setValue('');
          cleaned++;
        }
      }
    }
  }

  Logger.log('cleanStaleData: cleaned=' + cleaned + ' urlsFixed=' + urlsFixed);
  return respond({
    status: 'success',
    cleaned:  cleaned,
    urlsFixed: urlsFixed,
    message: 'Cleaned ' + cleaned + ' stale messages and fixed ' + urlsFixed + ' tracking URLs.'
  });
}

/* ════════════════════════════════════════════════════════════
   NATURAL SORT COMPARATOR
   Sorts strings with embedded numbers correctly:
   CJB1-1, CJB1-2, ..., CJB1-9, CJB1-10, CJB1-11
   IN-1, IN-2, ..., IN-9, IN-10, IN-11
   u3hs9001, u3hs9002, ..., u3hs9010
   Works by splitting into text/number segments and comparing each.
════════════════════════════════════════════════════════════ */
function naturalCompare(a, b) {
  var ax = [], bx = [];
  // Split into alternating [text, number, text, number...] segments
  String(a||'').replace(/(\d+)|(\D+)/g, function(_, n, s){ ax.push([s||'', n||'']); });
  String(b||'').replace(/(\d+)|(\D+)/g, function(_, n, s){ bx.push([s||'', n||'']); });
  while(ax.length && bx.length) {
    var an = ax.shift(), bn = bx.shift();
    // Compare text part first
    var c1 = an[0].toLowerCase().localeCompare(bn[0].toLowerCase());
    if(c1 !== 0) return c1;
    // Compare numeric part as integer
    var n1 = parseInt(an[1]||'0', 10), n2 = parseInt(bn[1]||'0', 10);
    if(n1 !== n2) return n1 - n2;
  }
  return ax.length - bx.length;
}

/* ════════════════════════════════════════════════════════════
   ACTION: sortByPlatformAndInvoice
   Sorts the Package Tracker sheet:
     Primary   → Platform (A→Z): Amazon < Amazon Bazaar < Flipkart < Meesho < ShopClues < Shopsy
     Secondary → Invoice Number (A→Z within each platform)
     Tertiary  → Order Date (oldest first within same invoice group)
════════════════════════════════════════════════════════════ */
function sortByPlatformAndInvoice() {
  const sheet   = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return respond({ status: 'success', message: 'Nothing to sort — sheet is empty.' });

  // Platform sort order (lower = first)
  const PLATFORM_ORDER = {
    'Amazon': 1, 'Amazon Bazaar': 2, 'Flipkart': 3, 'Shopsy': 4,
    'Meesho': 5, 'ShopClues': 6, 'IBI Website': 7, 'Unknown': 8
  };

  const dataRange = sheet.getRange(2, 1, lastRow - 1, HEADERS.length);
  const data      = dataRange.getValues();
  const formats   = dataRange.getNumberFormats();
  const fontColors= dataRange.getFontColors();
  const bgColors  = dataRange.getBackgrounds();

  data.sort(function(a, b) {
    // 1. Platform rank
    const pA = PLATFORM_ORDER[String(a[C.PLATFORM - 1] || '')] || 9;
    const pB = PLATFORM_ORDER[String(b[C.PLATFORM - 1] || '')] || 9;
    if (pA !== pB) return pA - pB;

    // 2. Invoice Number — natural sort: CJB1-1 < CJB1-2 < … < CJB1-9 < CJB1-10 < CJB1-11
    const invA = String(a[C.INVOICE_NO - 1] || '').trim();
    const invB = String(b[C.INVOICE_NO - 1] || '').trim();
    const invCmp = naturalCompare(invA, invB);
    if (invCmp !== 0) return invCmp;

    // 3. Order Date (DD/MM/YYYY → sortable)
    const dA = parseSortableDate(String(a[C.ORDER_DATE - 1] || ''));
    const dB = parseSortableDate(String(b[C.ORDER_DATE - 1] || ''));
    return dA - dB;
  });

  // Write sorted data back
  dataRange.setValues(data);
  dataRange.setNumberFormats(formats);
  dataRange.setFontColors(fontColors);
  dataRange.setBackgrounds(bgColors);

  Logger.log('sortByPlatformAndInvoice: sorted ' + data.length + ' rows');
  return respond({
    status: 'success',
    sorted: data.length,
    message: 'Sorted ' + data.length + ' rows by Platform → Invoice Number → Order Date.'
  });
}

/* ════════════════════════════════════════════════════════════
   ACTION: separateByMonth
   Creates/updates one tab per month (e.g. "Apr 2026", "Mar 2026")
   based on Order Date (falls back to Ship Date if Order Date empty).
   The master "Package Tracker" tab is NEVER deleted or modified.
   Monthly tabs are colour-coded and sorted Platform → Invoice.
════════════════════════════════════════════════════════════ */
function separateByMonth() {
  const ss        = SpreadsheetApp.openById(SHEET_ID);
  const master    = getSheet(); // ensures headers are correct
  const lastRow   = master.getLastRow();
  if (lastRow <= 1) return respond({ status: 'success', message: 'No data to separate.' });

  const allData = master.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();

  // Group rows by month (key = "MMM YYYY" e.g. "Apr 2026")
  var monthMap = {}; // { 'Apr 2026': [row, row, ...] }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  allData.forEach(function(row) {
    // ── Robust date extraction ─────────────────────────────────────────
    // GAS getValues() returns Date objects for date-formatted cells.
    // String dates may be DD/MM/YYYY, D/M/YYYY, YYYY-MM-DD, or JS Date.toString()
    var rawDate = row[C.ORDER_DATE - 1] || row[C.SHIP_DATE - 1] || '';
    var monthKey = 'Unknown';

    if (rawDate) {
      var mon = 0, yr = 0;

      if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
        // GAS Date object — most reliable
        mon = rawDate.getMonth() + 1; // getMonth() is 0-based
        yr  = rawDate.getFullYear();

      } else {
        var s = String(rawDate).trim();

        // DD/MM/YYYY or D/M/YYYY
        var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) { mon = parseInt(m[2], 10); yr = parseInt(m[3], 10); }

        // YYYY-MM-DD (ISO format)
        if (!mon) { m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) { mon = parseInt(m[2], 10); yr = parseInt(m[1], 10); } }

        // DD.MM.YYYY (dot-separated, Amazon format)
        if (!mon) { m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); if (m) { mon = parseInt(m[2], 10); yr = parseInt(m[3], 10); } }

        // JS Date.toString() format: "Mon Apr 01 2026 00:00:00 GMT+0530..."
        if (!mon) {
          m = s.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
          if (m) {
            var mIdx = MONTHS.indexOf(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase());
            if (mIdx >= 0) { mon = mIdx + 1; yr = parseInt(m[3], 10); }
          }
        }
      }

      if (mon >= 1 && mon <= 12 && yr >= 2020) {
        monthKey = MONTHS[mon - 1] + ' ' + yr;
      }
    }

    if (!monthMap[monthKey]) monthMap[monthKey] = [];
    monthMap[monthKey].push(row);
  });

  // Sort each month's rows by Platform → Invoice Number (natural) → Order Date
  const PLATFORM_ORDER = {
    'Amazon':1,'Amazon Bazaar':2,'Flipkart':3,'Shopsy':4,
    'Meesho':5,'ShopClues':6,'IBI Website':7,'Unknown':8
  };
  Object.keys(monthMap).forEach(function(key) {
    monthMap[key].sort(function(a, b) {
      const pA = PLATFORM_ORDER[String(a[C.PLATFORM-1]||'')] || 9;
      const pB = PLATFORM_ORDER[String(b[C.PLATFORM-1]||'')] || 9;
      if (pA !== pB) return pA - pB;
      // Natural sort for invoice numbers: CJB1-1, CJB1-2,...CJB1-9, CJB1-10, CJB1-11
      var iCmp = naturalCompare(String(a[C.INVOICE_NO-1]||''), String(b[C.INVOICE_NO-1]||''));
      if (iCmp !== 0) return iCmp;
      return parseSortableDate(String(a[C.ORDER_DATE-1]||'')) - parseSortableDate(String(b[C.ORDER_DATE-1]||''));
    });
  });

  // Tab colours per platform (used to colour-code header)
  const TAB_COLORS = [
    '#1a6ca8','#1d7a4a','#a04000','#7d3c98','#b7950b',
    '#1b6fa8','#922b21','#117a65','#515a5a','#641e16'
  ];

  var created = 0, updated = 0;
  var monthKeys = Object.keys(monthMap).filter(function(k){ return k !== 'Unknown'; });

  // Sort month keys chronologically (newest first)
  monthKeys.sort(function(a, b) {
    var parseKey = function(k) {
      var parts = k.split(' ');
      var mon = MONTHS.indexOf(parts[0]);
      var yr  = parseInt(parts[1], 10);
      return yr * 12 + mon;
    };
    return parseKey(b) - parseKey(a); // newest first
  });

  // Rows with no Order Date or Ship Date → "No Date" tab (last, grey)
  // These are typically: CSV-imported rows where date wasn't in the report,
  // or orders where AI couldn't extract the date from the PDF
  if (monthMap['Unknown'] && monthMap['Unknown'].length > 0) {
    monthMap['No Date'] = monthMap['Unknown'];
    delete monthMap['Unknown'];
    monthKeys.push('No Date');
  }

  monthKeys.forEach(function(monthKey, idx) {
    var rows       = monthMap[monthKey];
    var sheetName  = monthKey; // e.g. "Apr 2026" or "No Date"
    var isNoDate   = (monthKey === 'No Date');

    // Delete old "Unknown" tab if it exists (replaced by "No Date")
    var oldUnknown = ss.getSheetByName('Unknown');
    if (oldUnknown && isNoDate) {
      try { ss.deleteSheet(oldUnknown); } catch(e) {}
    }

    var existing = ss.getSheetByName(sheetName);
    if (!existing) {
      existing = ss.insertSheet(sheetName);
      created++;
    } else {
      existing.clearContents();
      updated++;
    }

    // Write header row
    existing.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    var hdr = existing.getRange(1, 1, 1, HEADERS.length);
    hdr.setBackground('#0D1B2A');
    hdr.setFontColor('#00D4F0');
    hdr.setFontWeight('bold');
    hdr.setFontSize(10);
    existing.setFrozenRows(1);

    // Write data rows
    if (rows.length > 0) {
      existing.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    }

    // Set same column widths as master
    existing.setColumnWidth(C.PRODUCTS,    380);
    existing.setColumnWidth(C.SHIP_ADDR,   260);
    existing.setColumnWidth(C.BILL_ADDR,   260);
    existing.setColumnWidth(C.STATUS_DTL,  220);
    existing.setColumnWidth(C.TRACK_URL,   200);
    existing.setColumnWidth(C.INVOICE_DATE,120);
    existing.setColumnWidth(C.ORDER_DATE,  120);
    existing.setColumnWidth(C.SHIP_DATE,   120);
    existing.setColumnWidth(C.EXP_DEL,     120);
    existing.getRange(1, C.ORDER_ID,  existing.getMaxRows(), 1).setNumberFormat('@STRING@');
    existing.getRange(1, C.AWB,       existing.getMaxRows(), 1).setNumberFormat('@STRING@');
    existing.getRange(1, C.INVOICE_NO,existing.getMaxRows(), 1).setNumberFormat('@STRING@');

    // Tab colour — "No Date" gets grey, monthly tabs cycle through palette
    existing.setTabColor(isNoDate ? '#888888' : TAB_COLORS[idx % TAB_COLORS.length]);

    // Note on header cell explaining contents
    var noteText = rows.length + ' orders · Generated ' + new Date().toLocaleString('en-IN');
    if (isNoDate) {
      noteText += '\n\nThese orders have no Order Date or Ship Date.\n'
        + 'Possible reasons:\n'
        + '• Imported from CSV/report where date was missing\n'
        + '• AI could not extract the date from the PDF\n'
        + 'Tip: Open each row, add the correct Order Date, then re-run Monthly Tabs.';
    }
    existing.getRange(1, 1).setNote(noteText);

    Logger.log('separateByMonth: ' + sheetName + ' → ' + rows.length + ' rows');
  });

  // Move Package Tracker to first position
  ss.setActiveSheet(master);
  ss.moveActiveSheet(1);

  return respond({
    status:  'success',
    created:  created,
    updated:  updated,
    months:   monthKeys.length,
    message:  'Created/updated ' + monthKeys.length + ' monthly tabs (' + created + ' new, ' + updated + ' refreshed). Master sheet unchanged.'
  });
}

/* ════════════════════════════════════════════════════════════
   ACTION: removeDuplicates
   Scans the Package Tracker sheet for rows with the same
   Order ID or Invoice Number, keeps the MOST COMPLETE row
   (most non-empty cells), and deletes the rest.

   "Most complete" = row with the most filled columns.
   If tie: keeps the row with the most recent Saved On timestamp.
   Meesho sub-orders (_1, _2 suffix) are treated as separate — no merge.
════════════════════════════════════════════════════════════ */
function removeDuplicates() {
  const sheet   = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return respond({ status:'success', message:'Sheet is empty — nothing to deduplicate.', removed:0 });

  const data = sheet.getDataRange().getValues();

  // Build a map of normalisedKey → array of {rowNum (1-based), completeness, savedOn, rowData}
  // Key = OrderID if present, else InvoiceNo, else AWB
  var keyMap = {}; // { key: [ {rowNum, score, savedOn} ] }

  for (var i = 1; i < data.length; i++) {
    const row       = data[i];
    const orderId   = normaliseId(String(row[C.ORDER_ID   -1]||''));
    const invoiceNo = normaliseId(String(row[C.INVOICE_NO -1]||''));
    const awb       = normaliseId(String(row[C.AWB        -1]||''));

    // For Meesho, keep sub-orders separate (orderId_1 ≠ orderId_2)
    // so do NOT strip the _1/_2 suffix (normaliseId already preserves it)
    var key = orderId || invoiceNo || awb || ('__row__' + i); // last resort: unique key

    if (!keyMap[key]) keyMap[key] = [];

    // Score = count of non-empty cells (more = more complete)
    var score = 0;
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) score++;
    }
    keyMap[key].push({ rowNum: i + 1, score: score, savedOn: String(row[C.SAVED_ON-1]||''), rowData: row });
  }

  // Collect rows to DELETE (all duplicates except the best one)
  var rowsToDelete = [];
  Object.keys(keyMap).forEach(function(key) {
    var group = keyMap[key];
    if (group.length <= 1) return; // no duplicate

    // Sort: highest score first; tie-break by most recent savedOn
    group.sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.savedOn.localeCompare(a.savedOn); // lexicographic — dd/MM/yyyy HH:mm:ss works
    });

    // Keep group[0] (best), delete the rest
    for (var j = 1; j < group.length; j++) {
      rowsToDelete.push(group[j].rowNum);
      Logger.log('removeDuplicates: DELETE row ' + group[j].rowNum + ' (key=' + key + ', score=' + group[j].score + ') — keeping row ' + group[0].rowNum);
    }
  });

  if (rowsToDelete.length === 0) {
    return respond({ status:'success', message:'✅ No duplicates found — sheet is clean.', removed:0 });
  }

  // Delete from bottom to top so row numbers stay valid
  rowsToDelete.sort(function(a, b){ return b - a; });
  rowsToDelete.forEach(function(r){ sheet.deleteRow(r); });

  Logger.log('removeDuplicates: removed ' + rowsToDelete.length + ' duplicate rows');
  return respond({
    status:  'success',
    removed:  rowsToDelete.length,
    message:  '✅ Removed ' + rowsToDelete.length + ' duplicate row' + (rowsToDelete.length!==1?'s':'' ) + '. Sheet is now clean.'
  });
}

/* ════════════════════════════════════════════════════════════
   AGE-BASED STATUS ESTIMATOR
   use shipment age to give an honest status instead of "In Transit".

   Indian courier SLA:
   • 0–1 day  → newly shipped, keep "Shipped"
   • 1–8 days → normal delivery window, "In Transit" is valid
   • 9–21 days → should be resolved; show "Unknown" + warning
   • > 21 days → definitely resolved; show "Unknown" + strong warning
════════════════════════════════════════════════════════════ */
function estimateStatusByAge(shipDateStr, orderDateStr, existingStatus) {
  const FINAL = ['Delivered', 'RTO Delivered', 'Rejected', 'Cancelled', 'Lost in Transit'];
  if (FINAL.indexOf(existingStatus) >= 0) return null; // already resolved

  var dateStr = shipDateStr || orderDateStr || '';
  var refDate = null;
  if (dateStr) {
    var m = String(dateStr).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) refDate = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    if (!refDate) {
      m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) refDate = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    }
  }
  if (!refDate) return null;

  var age = Math.floor((Date.now() - refDate.getTime()) / 86400000);
  Logger.log('estimateStatusByAge: ' + age + ' days old, existing=' + existingStatus);

  if (age < 1)  return null; // just shipped
  if (age <= 8) return null; // normal In Transit window — keep whatever sheet has

  if (age <= 21) return {
    status:      'Unknown',
    statusDetail: 'Shipment is ' + age + ' days old. Live API unavailable — check Seller Central or courier portal.',
    ageInDays:   age, ageWarning: true
  };
  return {
    status:      'Unknown',
    statusDetail: 'Shipment is ' + age + ' days old. Tracking data unavailable — likely delivered, returned, or resolved. Verify in Seller Central.',
    ageInDays:   age, ageWarning: true
  };
}

/* ════════════════════════════════════════════════════════════
   ACTION: getTracking
   Returns full tracking timeline for one AWB — called by the
   inline tracking widget in the app.

   ✅ KEY BEHAVIOUR: After fetching live status, the result is
      written back to the Google Sheet automatically so the
      Packages tab always shows the latest status without
      needing a separate Retrack click.
════════════════════════════════════════════════════════════ */
function getTracking(e) {
  const awb     = (e.parameter.awb     || '').trim();
  const courier = (e.parameter.courier || '').trim();
  if (!awb) return respond({ status: 'error', message: 'No AWB provided.' });

  // ── Step 1: Load existing sheet data as baseline ─────────
  const sheet    = getSheet();
  const rowIndex = findRowByAWB(sheet, awb);
  var sheetData  = { awb: awb, courier: courier, status: 'In Transit', events: [] };

  if (rowIndex) {
    const row = sheet.getRange(rowIndex, 1, 1, HEADERS.length).getValues()[0];
    sheetData = {
      awb:          awb,
      courier:      row[C.COURIER      - 1] || courier,
      platform:     row[C.PLATFORM     - 1] || '',
      orderId:      row[C.ORDER_ID     - 1] || '',
      status:       row[C.STATUS       - 1] || 'In Transit',
      statusDetail: row[C.STATUS_DTL   - 1] || '',
      currentCity:  '',
      currentTime:  row[C.LAST_TRACKED - 1] || '',
      origin:       '',
      destination:  row[C.SHIP_ADDR    - 1]
                      ? (row[C.SHIP_ADDR - 1] + '').split(',').pop().trim() : '',
      expectedDate: row[C.EXP_DEL      - 1] || '',
      events:       []
    };
  }

  const effectiveCourier = sheetData.courier || courier;

  // ── Step 2: Fetch live tracking data from carrier APIs ────
  var liveResult  = null;
  var scanData    = null;

  try {
    if (effectiveCourier === 'Delhivery') {
      // ── DELHIVERY ─────────────────────────────────────────
      const live = trackDelhivery(awb);
      if (live) {
        liveResult = live;
        if (live.updating) sheetData.updating = true;

        // Full scan history: TrackingMore → Merchant API → Shiprocket → 17track → Public
        const scanTM  = trackWithAfterShip(awb, 'Delhivery');
        const scanDel = (!scanTM  || !scanTM.events  || !scanTM.events.length)
                        ? trackWithDelhiveryMerchant(awb) : null;
        const scanSR  = (!scanDel || !scanDel.events || !scanDel.events.length)
                        ? trackWithShiprocket(awb) : null;
        const scan17  = (!scanDel && !scanSR)
                        ? trackWith17track(awb, 3604) : null;
        scanData = (scanTM  && scanTM.events  && scanTM.events.length)  ? scanTM
                 : (scanDel && scanDel.events && scanDel.events.length) ? scanDel
                 : (scanSR  && scanSR.events  && scanSR.events.length)  ? scanSR
                 : (scan17  && scan17.events  && scan17.events.length)  ? scan17
                 : getDelhiveryScanHistory(awb);
      }

    } else if (effectiveCourier === 'Amazon Transportation Services') {
      // ── AMAZON ATS ────────────────────────────────────────
      const live = trackAmazon(awb);
      if (live) {
        liveResult = live;
        // Amazon: scan timeline comes from same TrackingMore call
        if (live.events && live.events.length > 0) scanData = live;
      }

    } else if (effectiveCourier === 'eKart Logistics') {
      // ── EKART ─────────────────────────────────────────────
      const live = trackEkart(awb);
      if (live) {
        liveResult = live;
        if (live.events && live.events.length > 0) scanData = live;
      }
    }
  } catch (err) {
    Logger.log('getTracking live fetch error for ' + effectiveCourier + ': ' + err.message);
  }

  // ── Step 3: Merge live result into sheetData ──────────────
  const VALID_STATUSES = [
    'Delivered', 'Out for Delivery', 'In Transit', 'Shipped', 'Pending',
    'Not Delivered', 'RTO Initiated', 'RTO Delivered',
    'Rejected', 'Stuck at Hub', 'Lost in Transit', 'Cancelled', 'Unknown'
  ];

  var liveDataFound = false;

  if (liveResult) {
    if (liveResult.status && VALID_STATUSES.indexOf(liveResult.status) >= 0) {
      sheetData.status = liveResult.status;
      liveDataFound = true;
    }
    if (liveResult.statusDetail && liveResult.statusDetail.trim() &&
        !liveResult.statusDetail.includes('tracking link')) {
      sheetData.statusDetail = liveResult.statusDetail;
    }
    if (liveResult.lastLocation)  sheetData.currentCity = liveResult.lastLocation;
    if (liveResult.lastEventTime) sheetData.currentTime = liveResult.lastEventTime;
    if (liveResult.expectedDate)  sheetData.expectedDate = liveResult.expectedDate || sheetData.expectedDate;
    if (liveResult.updating)      sheetData.updating = true;
  }

  if (scanData) {
    sheetData.origin      = scanData.origin      || sheetData.origin      || '';
    sheetData.destination = scanData.destination || sheetData.destination || '';
    if (scanData.expectedDate) sheetData.expectedDate = scanData.expectedDate;
    if (scanData.events && scanData.events.length > 0) {
      sheetData.events  = scanData.events;
      liveDataFound     = true;
    }
    if (scanData.status && VALID_STATUSES.indexOf(scanData.status) >= 0 &&
        isMoreSpecificStatus(scanData.status, sheetData.status)) {
      sheetData.status = scanData.status;
    }
  }

  // ── If all APIs failed: use age-based estimation ──────────
  // Never lie with "In Transit" for a 1-month-old order.
  if (!liveDataFound) {
    var shipDateVal  = rowIndex ? String(sheet.getRange(rowIndex, C.SHIP_DATE).getValue()  || '') : '';
    var orderDateVal = rowIndex ? String(sheet.getRange(rowIndex, C.ORDER_DATE).getValue() || '') : '';
    var ageEstimate  = estimateStatusByAge(shipDateVal, orderDateVal, sheetData.status);

    if (ageEstimate) {
      sheetData.status      = ageEstimate.status;
      sheetData.statusDetail= ageEstimate.statusDetail;
      sheetData.ageInDays   = ageEstimate.ageInDays;
      sheetData.ageWarning  = true;
      Logger.log('getTracking: applied age estimate for ' + awb + ' — ' + ageEstimate.status + ' (' + ageEstimate.ageInDays + ' days)');
    } else {
      // Keep existing sheet status + add a neutral note
      if (!sheetData.statusDetail || sheetData.statusDetail.includes('Use Track button')) {
        sheetData.statusDetail = 'Live tracking data unavailable. Try 🔄 Retrack or check the courier portal.';
      }
    }
    sheetData.noLiveData = true;
  }

  // ── Step 4: ✅ WRITE BACK TO GOOGLE SHEET ────────────────
  if (rowIndex && sheetData.status && VALID_STATUSES.indexOf(sheetData.status) >= 0) {
    const now = timestamp();
    try {
      sheet.getRange(rowIndex, C.STATUS      ).setValue(sheetData.status);
      sheet.getRange(rowIndex, C.STATUS_DTL  ).setValue(sheetData.statusDetail || '');
      sheet.getRange(rowIndex, C.LAST_TRACKED).setValue(now);

      // Update Tracking URL — for eKart, update to status-specific Flipkart page
      // e.g. Delivered → shipments_delivered, RTO → returnsV2, etc.
      const updatedTrackUrl = getTrackingUrl(effectiveCourier, awb, sheetData.orderId || '', sheetData.status);
      if (updatedTrackUrl) {
        sheet.getRange(rowIndex, C.TRACK_URL).setValue(updatedTrackUrl);
        sheetData.trackUrl = updatedTrackUrl; // pass back to modal
      }

      if (sheetData.expectedDate) {
        const existingExpDel = String(sheet.getRange(rowIndex, C.EXP_DEL).getValue() || '').trim();
        if (!existingExpDel || existingExpDel === '—') {
          sheet.getRange(rowIndex, C.EXP_DEL).setValue(sheetData.expectedDate);
        }
      }
      sheetData.currentTime = now;
      Logger.log('getTracking: saved status "' + sheetData.status + '" + trackUrl for AWB ' + awb);
    } catch (writeErr) {
      Logger.log('getTracking: sheet write error — ' + writeErr.message);
    }
  }

  // ── Step 5: Return data to frontend ──────────────────────
  const props2 = PropertiesService.getScriptProperties();
  sheetData.delhiveryKeySet = !!props2.getProperty('DELHIVERY_API_KEY');
  sheetData.aftershipKeySet = !!(props2.getProperty('TRACKINGMORE_API_KEY') || props2.getProperty('AFTERSHIP_API_KEY'));
  sheetData.savedToSheet    = !!rowIndex; // tell frontend if status was saved

  return respond({ status: 'success', data: sheetData });
}

// Try to get full scan history from Delhivery API
function getDelhiveryScanHistory(awb) {
  try {
    const url = 'https://track.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(awb);
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'Accept':'application/json', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const code = res.getResponseCode();
    if (code !== 200) {
      Logger.log('Delhivery scan history API: ' + code);
      return null;
    }
    const data = JSON.parse(res.getContentText());
    if (!data.ShipmentData || !data.ShipmentData.length) return null;

    const sh = data.ShipmentData[0].Shipment;
    const events = (sh.Scans || []).map(function(scan) {
      return {
        time:     scan.ScanDetail.StatusDateTime  || '',
        location: scan.ScanDetail.ScannedLocation || '',
        status:   scan.ScanDetail.Scan            || '',
        detail:   scan.ScanDetail.Instructions    || ''
      };
    }).reverse();

    return {
      origin:       sh.OriginCity           || '',
      destination:  sh.DestinationCity      || '',
      expectedDate: sh.ExpectedDeliveryDate || '',
      events:       events
    };
  } catch(e) {
    Logger.log('getDelhiveryScanHistory error: ' + e.message);
    return null;
  }
}

/* ════════════════════════════════════════════════════════════
   ACTION: importReport
   Direct CSV parsing — handles ALL rows, no AI token limits
   AI used only as fallback if direct parsing can't detect columns
════════════════════════════════════════════════════════════ */
function importReport(e) {
  const csvData    = e.parameter.csvData    || '';
  const reportType = e.parameter.reportType || 'auto';
  const fileName   = e.parameter.fileName   || '';
  if (!csvData || csvData.trim().length < 10) return respond({ status:'error', message:'No CSV data received.' });

  // Step 1: Try direct CSV parsing (handles all rows, no limits)
  let orders = [];
  try {
    orders = parseCSVDirect(csvData, reportType, fileName);
    Logger.log('Direct CSV parse: ' + orders.length + ' orders found');
  } catch(err) {
    Logger.log('Direct CSV parse failed: ' + err.message);
  }

  // Step 2: If direct parse got 0 results, fall back to AI on first 15000 chars
  if (!orders || orders.length === 0) {
    Logger.log('Falling back to AI parsing');
    const prompt   = buildReportPrompt(csvData.substring(0, 15000), reportType, fileName);
    const activeAI = PropertiesService.getScriptProperties().getProperty('ACTIVE_AI') || 'gemini';
    const props    = PropertiesService.getScriptProperties();
    const aiOrder  = activeAI === 'openai'   ? ['openai','claude','gemini','deepseek']
                   : activeAI === 'claude'   ? ['claude','openai','gemini','deepseek']
                   : activeAI === 'deepseek' ? ['deepseek','gemini','openai','claude']
                   :                           ['gemini','openai','claude','deepseek'];
    let lastError  = '';
    for (const ai of aiOrder) {
      try {
        if      (ai === 'openai'   && props.getProperty('OPENAI_API_KEY'))   { orders = extractReportWithOpenAI(prompt);   break; }
        else if (ai === 'claude'   && props.getProperty('CLAUDE_API_KEY'))   { orders = extractReportWithClaude(prompt);   break; }
        else if (ai === 'gemini'   && props.getProperty('GEMINI_API_KEY'))   { orders = extractReportWithGemini(prompt);   break; }
        else if (ai === 'deepseek' && props.getProperty('DEEPSEEK_API_KEY')) { orders = extractReportWithDeepSeek(prompt); break; }
      } catch(err) {
        lastError = ai + ': ' + err.message;
        Logger.log('AI fallback failed - ' + lastError);
        Utilities.sleep(1000);
      }
    }
    if (!orders || orders.length === 0) {
    const detail = lastError ? lastError : 'No orders found. Please select the Platform manually from the dropdown and try again, or check that the file has order data.';
    return respond({ status:'error', message: detail });
  }
  }

  // Step 3: Sort orders by order date (oldest first) before saving
  orders.sort(function(a, b) {
    var da = parseSortableDate(a.orderDate || a.shipDate || '');
    var db = parseSortableDate(b.orderDate || b.shipDate || '');
    return da - db;
  });

  // Step 4: Save all orders to sheet
  const sheet = getSheet();
  const now   = timestamp();
  let saved = 0, updated = 0, skipped = 0;

  for (const o of orders) {
    // Clean AWB: strip label prefixes but KEEP the TBA number intact
    // TBA123456789 IS the tracking number — do NOT strip TBA from it
    // Strips: "AWB " (space), "AWB:", "AWB No.", "DTr:", "Tracking No:", "Consignment No:"
    if (o.awb) o.awb = o.awb.replace(/^(DTr\s*:\s*|AWB\s*No\.?\s*:?\s*|AWB\s*:\s*|AWB\s+|Tracking\s*(?:No\.?\s*)?:\s*|Consignment\s*(?:No\.?\s*)?:\s*)/i,'').trim();
    // Clean Order ID:
    // 1. Strip Flipkart "OI:" prefix
    // 2. Strip Meesho "_1"/"_2" sub-order suffix so CSV and PDF match same row
    if (o.orderId) {
      o.orderId = o.orderId.replace(/^OI:/i, '').trim();
      if (o.platform === 'Meesho') {
        o.orderId = o.orderId.replace(/_[0-9]+$/, '').trim();
      }
    }
    if (!o.orderId && !o.awb) {
      if (skipped === 0) Logger.log('First skipped row sample: ' + JSON.stringify(rowData.slice(0,8)));
      skipped++;
      continue;
    }
    o.courier = COURIER_MAP[o.platform] || 'Unknown';
    // AWB = primary key (each shipment has unique AWB)
    // Order ID fallback: only match rows with empty AWB (bulk-imported rows)
    // This allows PDF upload to find and merge with bulk-imported rows that had no AWB
    var existingByAWB = o.awb ? findRowByAWB(sheet, o.awb) : null;
    var existingByOID = o.orderId ? findRowByOrderId(sheet, o.orderId, true) : null;
    const existing = existingByAWB || existingByOID;

    const row = [
      now, o.platform||'', o.courier, String(o.orderId||''), String(o.awb||''),
      o.invoiceNumber||'', o.invoiceDate||'', o.orderDate||'',
      o.buyerName||'', o.buyerPhone||'',
      o.shippingAddress||'', o.billingAddress||o.shippingAddress||'', o.pincode||'',
      o.products||'', o.qty||'', o.amount||'', o.paymentType||'COD',
      o.shipDate||'', o.expectedDelivery||'',
      o.status||'Shipped', o.statusDetail||'Imported from report',
      getTrackingUrl(o.courier, o.awb, o.orderId), now
    ];

    if (existing) {
      mergeRow(sheet, existing, {
        platform: o.platform, courier: o.courier, orderId: o.orderId, awb: o.awb,
        invoiceNumber: o.invoiceNumber, invoiceDate: o.invoiceDate, orderDate: o.orderDate,
        buyerName: o.buyerName, buyerPhone: o.buyerPhone,
        shippingAddress: o.shippingAddress, billingAddress: o.billingAddress,
        pincode: o.pincode, products: o.products,
        qty: o.qty, amount: o.amount, paymentType: o.paymentType,
        shipDate: o.shipDate, expectedDelivery: o.expectedDelivery,
        status: o.status, statusDetail: o.statusDetail,
        trackUrl: getTrackingUrl(o.courier, o.awb, o.orderId)
      }, now);
      updated++;
    } else {
      sheet.appendRow(row);
      saved++;
    }
  }

  // Pre-register Delhivery AND eKart AWBs with TrackingMore so tracking
  // data is available immediately when user clicks 📡 Track
  try {
    const delAWBs = orders
      .filter(function(o){ return o.courier === 'Delhivery' && o.awb; })
      .map(function(o){ return String(o.awb); });
    if (delAWBs.length > 0) {
      preRegisterWithTrackingMore(delAWBs, 'delhivery');
      Logger.log('Pre-registered ' + delAWBs.length + ' Delhivery AWBs');
    }
    const ekartAWBs = orders
      .filter(function(o){ return o.courier === 'eKart Logistics' && o.awb; })
      .map(function(o){ return String(o.awb); });
    if (ekartAWBs.length > 0) {
      Utilities.sleep(300);
      preRegisterWithTrackingMore(ekartAWBs, 'ekart');
      Logger.log('Pre-registered ' + ekartAWBs.length + ' eKart AWBs');
    }
  } catch(e) { Logger.log('Pre-register error: ' + e.message); }

  return respond({ status:'success', saved, updated, skipped, total: orders.length });
}

/* ────────────────────────────────────────────────────────────
   DIRECT CSV PARSER — handles all rows without AI
   Detects platform from headers and maps columns accordingly
──────────────────────────────────────────────────────────── */
function parseCSVDirect(csvData, reportType, fileName) {
  const rows = parseCSVRows(csvData);
  if (rows.length < 2) throw new Error('CSV has fewer than 2 rows. Total chars received: ' + csvData.length);

  const headers = rows[0].map(h => (h||'').toLowerCase().trim().replace(/[^a-z0-9\s\-_]/g,'').trim());
  const headerStr = headers.slice(0,15).join(' | ');
  Logger.log('CSV headers: ' + headerStr);
  Logger.log('Total rows: ' + rows.length);

  // Detect platform from headers, filename, or reportType hint
  const platform = detectPlatform(headers, fileName, reportType);
  Logger.log('Detected platform: ' + platform);
  if (platform === 'Unknown') {
    throw new Error('Platform not detected. First 10 headers: ' + headerStr);
  }

  // Get column mapping for this platform
  const map = getColumnMap(headers, platform);
  Logger.log('Column map: ' + JSON.stringify(map));
  Logger.log('Key cols — orderId:' + map.orderId + ' awb:' + map.awb + ' products:' + map.products);

  const orders = [];
  for (let i = 1; i < rows.length; i++) {
    var rowData = rows[i];
    if (!rowData || rowData.every(function(c){ return !c || !c.trim(); })) continue; // skip empty rows

    var get = function(key) {
      if (map[key] !== undefined && map[key] >= 0) return (rowData[map[key]]||'').trim();
      return '';
    };

    const orderId = get('orderId');
    const awb     = get('awb');
    if (!orderId && !awb) continue;

    // Build product string: combine product-name + asin/sku
    // Clean Flipkart's extra quotes and "SKU:" prefix
    var rawProduct = (get('products') || '').replace(/^["\s]+|["\s]+$/g,'').replace(/^SKU:/i,'').trim();
    var rawSKU     = (get('sku') || '').replace(/^["\s]+|["\s]+$/g,'').replace(/^SKU:/i,'').trim();
    var rawAsin    = '';
    if (map['asin'] !== undefined && map['asin'] >= 0) rawAsin = (rowData[map['asin']]||'').trim();

    var productStr = '';
    if (rawProduct && rawProduct !== rawSKU && rawProduct !== rawAsin) {
      // Full product name available
      var skuPart = rawAsin || rawSKU;
      productStr = skuPart ? rawProduct + ' | SKU: ' + skuPart : rawProduct;
    } else if (rawSKU && rawAsin && rawSKU !== rawAsin) {
      // Both SKU description and ASIN available
      productStr = rawSKU + ' | SKU: ' + rawAsin;
    } else if (rawAsin) {
      productStr = rawAsin;
    } else if (rawSKU) {
      productStr = rawSKU;
    } else if (rawProduct) {
      productStr = rawProduct;
    }

    orders.push({
      platform:        platform,
      orderId:         orderId,
      awb:             awb,
      invoiceNumber:   get('invoiceNumber'),
      invoiceDate:     normaliseDate(get('invoiceDate')),
      orderDate:       normaliseDate(get('orderDate')),
      buyerName:       get('buyerName'),
      buyerPhone:      get('buyerPhone'),
      shippingAddress: get('address'),
      billingAddress:  get('billingAddress') || get('address'),
      pincode:         get('pincode'),
      products:        productStr,
      qty:             get('qty') || '1',
      amount:          cleanAmount(get('amount')),
      paymentType:     normalisePayType(get('paymentType')),
      shipDate:        normaliseDate(get('shipDate')),
      expectedDelivery:normaliseDate(get('expectedDelivery')),
      status:          normaliseStatus(get('status')),
      statusDetail:    get('statusDetail') || get('status')
    });
  }
  return orders;
}

function detectPlatform(headers, fileName, hint) {
  const h = headers.join(' ');
  const f = (fileName||'').toLowerCase();
  if (hint && hint !== 'auto') return hint;
  // Meesho: has "sub order no" or "fsn" style or meesho in filename
  if (h.includes('sub order') || h.includes('supplier order') || f.includes('meesho')) return 'Meesho';
  // Amazon: has "orderid" or "order-id" or amazon-style
  if (h.includes('order-id') || h.includes('amazonorderid') || h.includes('asin') || f.includes('amazon')) return 'Amazon';
  // Flipkart: has "ekart" or "flipkart" or "fsn"
  if (h.includes('ekart') || h.includes('flipkart') || h.includes('fsn') || h.includes('delivery_tracking_id') || h.includes('order_item_id') || h.includes('order item id') || f.includes('flipkart') || f.includes('shopsy')) { Logger.log('Detected Flipkart from headers: ' + h.substring(0,100)); return 'Flipkart'; }
  // ShopClues
  if (h.includes('shopclues') || f.includes('shopclues')) return 'ShopClues';
  return 'Unknown';
}

function getColumnMap(headers, platform) {
  // Generic fuzzy column finder — tries both hyphenated and space versions
  const find = (...terms) => {
    for (const term of terms) {
      // Try exact substring match first
      let idx = headers.findIndex(h => h.includes(term));
      if (idx >= 0) return idx;
      // Try with hyphens replaced by spaces
      const spaced = term.replace(/-/g, ' ');
      idx = headers.findIndex(h => h.includes(spaced));
      if (idx >= 0) return idx;
      // Try with spaces replaced by hyphens
      const hyphenated = term.replace(/\s+/g, '-');
      idx = headers.findIndex(h => h.includes(hyphenated));
      if (idx >= 0) return idx;
      // Try stripped (no spaces or hyphens)
      const stripped = term.replace(/[\s-]/g, '');
      idx = headers.findIndex(h => h.replace(/[\s-]/g,'').includes(stripped));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  if (platform === 'Meesho') {
    return {
      orderId:         find('sub order no', 'suborderid', 'order no', 'order id'),
      awb:             find('awb', 'tracking id', 'tracking no', 'docket', 'shipment id'),
      buyerName:       find('customer name', 'buyer name', 'ship to name', 'shipping name'),
      buyerPhone:      find('customer phone', 'phone', 'mobile', 'contact'),
      address:         find('customer address', 'shipping address', 'address'),
      pincode:         find('pincode', 'pin code', 'zip'),
      products:        find('product name', 'item name', 'sku', 'product'),
      qty:             find('quantity', 'qty', 'units'),
      amount:          find('final price', 'order amount', 'amount', 'price', 'total'),
      paymentType:     find('payment type', 'payment mode', 'payment method'),
      shipDate:        find('ship date', 'shipped date', 'dispatch date'),
      expectedDelivery:find('expected delivery', 'delivery date', 'delivery by'),
      status:          find('order status', 'shipment status', 'status'),
      statusDetail:    find('status reason', 'remarks', 'comments'),
      asin:            find('asin'),
      sku:             find('sku', 'product sku', 'seller sku'),
      invoiceNumber:   find('invoice no', 'invoice number', 'bill no'),
      invoiceDate:     find('invoice date', 'bill date'),
      orderDate:       find('order date', 'purchase date', 'created date'),
      billingAddress:  find('billing address', 'bill to')
    };
  }

  if (platform === 'Amazon') {
    return {
      orderId:         find('order-id', 'orderid', 'order id', 'amazon order id', 'amazonorderid'),
      awb:             find('tracking-id', 'tracking id', 'awb', 'shipment id', 'tracking number', 'carrier tracking number'),
      buyerName:       find('recipient-name', 'buyer-name', 'ship-name', 'recipient name', 'customer', 'shipping name'),
      buyerPhone:      find('ship-phone-number', 'phone', 'mobile', 'buyer phone number'),
      address:         find('ship-address', 'shipping address', 'address-1', 'address', 'ship address 1'),
      pincode:         find('ship-postal-code', 'pincode', 'postal code', 'zip', 'ship zip'),
      asin:            find('asin'),
      sku:             find('sku', 'merchant sku', 'seller sku'),
      products:        find('product-name', 'productname', 'item-name', 'itemname', 'item-description', 'product title', 'title', 'description', 'product', 'name'),
      qty:             find('quantity', 'qty', 'units-ordered'),
      amount:          find('item-price', 'order-total', 'amount', 'price', 'total'),
      paymentType:     find('payment-method', 'payment-type', 'payment type', 'is-cod', 'payment'),
      shipDate:        find('ship-date', 'shipped-date', 'purchase-date'),
      expectedDelivery:find('promised-delivery', 'delivery-date', 'delivery by'),
      status:          find('order-status', 'status'),
      statusDetail:    find('cancellation-reason', 'reason', 'comments'),
      invoiceNumber:   find('invoice-number', 'invoice no'),
      invoiceDate:     find('invoice-date', 'invoice date'),
      orderDate:       find('purchase-date', 'order date', 'order-date'),
      billingAddress:  find('bill-address', 'billing address', 'bill-address-1')
    };
  }

  if (platform === 'Flipkart') {
    return {
      orderId:         find('order_id', 'order id', 'orderid', 'order no'),
      awb:             find('delivery_tracking_id', 'awb no', 'awb', 'tracking id', 'tracking'),
      buyerName:       find('customer name', 'ship to', 'buyer name'),
      buyerPhone:      find('phone', 'mobile', 'contact'),
      address:         find('shipping_address', 'shipping address', 'address'),
      pincode:         find('pincode', 'pin', 'zip'),
      asin:            find('fsn', 'asin'),
      sku:             find('sku', 'product id', 'seller sku'),
      products:        find('product_title', 'product title', 'product name', 'item'),
      qty:             find('quantity', 'qty'),
      amount:          find('selling_price', 'final settlement amount', 'order amount', 'total', 'amount', 'price'),
      paymentType:     find('payment_type', 'payment mode', 'payment type', 'cod_flag', 'is_cod'),
      shipDate:        find('dispatched_date', 'dispatch date', 'shipped date', 'ship date'),
      expectedDelivery:find('deliver_by_date', 'order_delivery_date', 'expected delivery', 'delivery date'),
      status:          find('order_item_status', 'shipment status', 'order status', 'status'),
      statusDetail:    find('cancellation_reason', 'return_reason', 'cancellation reason', 'return reason', 'remarks'),
      invoiceNumber:   find('forward_logistics_form_no', 'invoice no', 'invoice number'),
      invoiceDate:     find('invoice date', 'bill date'),
      orderDate:       find('order_date', 'order date', 'purchase date'),
      billingAddress:  find('billing address', 'bill to', 'bill address')
    };
  }

  if (platform === 'ShopClues') {
    return {
      orderId:         find('order id', 'order no', 'orderid'),
      awb:             find('awb number', 'awb no', 'awb', 'tracking'),
      buyerName:       find('customer name', 'buyer name', 'ship to'),
      buyerPhone:      find('phone', 'mobile', 'contact'),
      address:         find('shipping address', 'address'),
      pincode:         find('pincode', 'pin', 'zip'),
      products:        find('product name', 'item name', 'sku'),
      qty:             find('quantity', 'qty'),
      amount:          find('order value', 'total', 'amount', 'price'),
      paymentType:     find('payment mode', 'payment type'),
      shipDate:        find('ship date', 'dispatch date'),
      expectedDelivery:find('expected delivery', 'delivery date'),
      status:          find('order status', 'status'),
      statusDetail:    find('reason', 'remarks'),
      asin:            find('asin'),
      sku:             find('sku', 'product id'),
      invoiceNumber:   find('invoice no'),
      invoiceDate:     find('invoice date'),
      orderDate:       find('order date'),
      billingAddress:  find('billing address', 'bill to')
    };
  }

  // Generic fallback — try common column names
  return {
    orderId:         find('order id', 'order no', 'orderid', 'order-id'),
    awb:             find('awb', 'tracking', 'tracking id', 'awb no'),
    buyerName:       find('customer name', 'buyer', 'name', 'recipient'),
    buyerPhone:      find('phone', 'mobile', 'contact'),
    address:         find('address', 'shipping address'),
    pincode:         find('pincode', 'pin', 'postal'),
    products:        find('product', 'item', 'sku', 'title'),
    qty:             find('qty', 'quantity'),
    amount:          find('amount', 'total', 'price', 'value'),
    paymentType:     find('payment'),
    shipDate:        find('ship date', 'shipped'),
    expectedDelivery:find('delivery date', 'expected'),
    status:          find('status'),
    statusDetail:    find('reason', 'remarks'),
    invoiceNumber:   find('invoice')
  };
}

/* ── CSV PARSER — handles quoted fields, commas inside quotes ── */
function parseCSVRows(csv) {
  const rows = [];
  // Normalize line endings
  const lines = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length === 0) return rows;

  // Auto-detect delimiter: tab or comma
  // Check first non-empty line — if it has more tabs than commas, use tab
  const firstLine = lines.find(function(l){ return l.trim().length > 0; }) || '';
  const tabCount   = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g)   || []).length;
  const delimiter  = tabCount > commaCount ? '\t' : ',';
  Logger.log('CSV delimiter detected: ' + (delimiter === '\t' ? 'TAB' : 'COMMA') + ' (tabs:' + tabCount + ' commas:' + commaCount + ')');

  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(parseCSVLine(line, delimiter));
  }
  return rows;
}

function parseCSVLine(line, delimiter) {
  delimiter = delimiter || ',';
  // For tab-delimited, simple split is safe (no quoting issues)
  if (delimiter === '\t') {
    return line.split('\t').map(function(c){ return c.trim(); });
  }
  // For comma-delimited, handle quoted fields
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/* ── NORMALISE HELPERS ── */
function cleanAmount(val) {
  if (!val) return '';
  // Remove currency symbols, commas, spaces — keep only digits and decimal point
  return val.replace(/Rs\.?/gi,'').replace(/INR/gi,'').replace(/[^0-9.]/g,'').trim();
}

function normalisePayType(val) {
  const v = (val||'').toLowerCase().trim();
  // Flipkart/Amazon fulfillment type — NOT payment method, skip it
  if (v === 'merchant' || v === 'amazon' || v === 'non_fbf' || v === 'fbf' || v === 'seller') return '';
  // Actual payment type values
  if (v.includes('prepaid') || v.includes('online') || v.includes('paid') || v.includes('upi') || v.includes('card') || v.includes('net banking')) return 'Prepaid';
  if (v.includes('cod') || v.includes('cash on delivery') || v === 'cash') return 'COD';
  if (v === 'true' || v === '1' || v === 'yes') return 'COD'; // some reports use is_cod flag
  if (v === 'false' || v === '0' || v === 'no') return 'Prepaid';
  // If value is not recognisable, return empty (better than wrong value)
  return '';
}

/* ════════════════════════════════════════════════════════════
   MASTER STATUS NORMALISER
   Converts ANY raw courier status string → clean IBI status

   CANONICAL STATUS SET:
   ✅  Delivered         — successfully delivered
   🚚  Out for Delivery  — with delivery executive
   📦  In Transit        — moving through network
   📬  Shipped           — picked up, not yet in transit
   ⏳  Pending           — not yet picked up / manifested
   ❌  Not Delivered     — delivery failed / NDR
   🔄  RTO Initiated     — return to origin started
   📮  RTO Delivered     — returned to sender's hub
   🚫  Rejected          — customer refused to accept
   ⚠️  Stuck at Hub      — exception / stuck / held
   💀  Lost in Transit   — shipment lost
   🗑️  Cancelled         — order cancelled before dispatch
════════════════════════════════════════════════════════════ */
function normaliseStatus(val) {
  const v = (val || '').toLowerCase().trim()
    .replace(/_/g, ' ').replace(/\s+/g, ' ');

  // ── DELIVERED ────────────────────────────────────────────
  if (v === 'delivered') return 'Delivered';
  if (v.includes('delivered') &&
      !v.includes('rto') && !v.includes('return') &&
      !v.includes('undelivered') && !v.includes('not delivered') &&
      !v.includes('failed')) return 'Delivered';
  if (v === 'dl' || v === 'dlv') return 'Delivered';

  // ── OUT FOR DELIVERY ──────────────────────────────────────
  if (v.includes('out for delivery') || v === 'ofd' || v === 'out for del')
    return 'Out for Delivery';
  if (v === 'dispatched for delivery' || v === 'with courier')
    return 'Out for Delivery';

  // ── RTO DELIVERED (before RTO Initiated) ─────────────────
  if ((v.includes('rto') && v.includes('delivered')) ||
      v === 'rto delivered' || v === 'rto_delivered' || v === 'return delivered')
    return 'RTO Delivered';
  if (v === 'returned' || v === 'shipment returned' || v === 'return completed')
    return 'RTO Delivered';

  // ── RTO INITIATED ─────────────────────────────────────────
  if (v.includes('rto') || v === 'rto_initiated' || v === 'rto intransit' ||
      v === 'rto out for delivery' || v === 'return to origin' ||
      v === 'return initiated' || v === 'return to shipper' ||
      v === 'return_to_sender')
    return 'RTO Initiated';
  if (v.includes('return') && !v.includes('return approved') &&
      !v.includes('return request'))
    return 'RTO Initiated';

  // ── REJECTED ──────────────────────────────────────────────
  if (v.includes('reject') || v === 'refused' || v === 'shipment rejected' ||
      v === 'consignee refused' || v === 'delivery rejected' ||
      v === 'returned by consignee')
    return 'Rejected';

  // ── NOT DELIVERED (NDR / Attempt failed) ─────────────────
  if (v.includes('not delivered') || v === 'undelivered' ||
      v === 'ndr' || v.includes('ndr pending') ||
      v.includes('failed attempt') || v.includes('delivery failed') ||
      v.includes('delivery exception') || v.includes('attempted delivery') ||
      v.includes('delivery attempt') || v === 'failed_attempt' ||
      v === 'customer not available' || v === 'door locked' ||
      v === 'address issue')
    return 'Not Delivered';

  // ── CANCELLED ────────────────────────────────────────────
  if (v.includes('cancel') || v === 'cancelled' || v === 'canceled')
    return 'Cancelled';

  // ── STUCK / EXCEPTION ────────────────────────────────────
  if (v.includes('stuck') || v === 'exception' || v === 'on hold' ||
      v === 'held at hub' || v === 'misrouted' || v === 'damaged' ||
      v === 'customs hold' || v.includes('delay'))
    return 'Stuck at Hub';

  // ── LOST ─────────────────────────────────────────────────
  if (v.includes('lost') || v === 'missing') return 'Lost in Transit';

  // ── IN TRANSIT ───────────────────────────────────────────
  if (v.includes('in transit') || v === 'in_transit' || v === 'transit' ||
      v === 'forwarded' || v === 'transit in' || v.includes('hub transit') ||
      v.includes('reached') || v.includes('arrived'))
    return 'In Transit';

  // ── SHIPPED (picked up, initial scan) ────────────────────
  if (v.includes('ship') || v.includes('dispatch') || v === 'picked' ||
      v === 'pickup' || v === 'manifested' || v === 'booked' ||
      v === 'info received' || v === 'info_received' ||
      v === 'tracking initiated' || v === 'label created' ||
      v === 'pending' && false)   // 'pending' → handled below
    return 'Shipped';

  // ── PENDING (not yet picked up) ──────────────────────────
  if (v === 'pending' || v.includes('processing') || v === 'approved' ||
      v === 'order placed' || v === 'awaiting pickup' || v === 'not picked up')
    return 'Pending';

  // ── FALLBACK ─────────────────────────────────────────────
  return val || 'In Transit';
}

// Convert DD/MM/YYYY to a numeric timestamp for sorting
function parseSortableDate(val) {
  if (!val) return 0;
  // GAS Date object
  if (val instanceof Date) return isNaN(val.getTime()) ? 0 : val.getTime();
  var s = String(val).trim();
  if (!s) return 0;
  // DD/MM/YYYY or D/M/YYYY
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1])).getTime();
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3])).getTime();
  // DD.MM.YYYY (Amazon dot format)
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1])).getTime();
  return 0;
}

/* ────────────────────────────────────────────────────────────
   toIsoDate(val) → "YYYY-MM-DD"   (locale-proof, DAY-FIRST aware)
   ─────────────────────────────────────────────────────────────
   ROOT-CAUSE FIX for the Google-Sheets US-locale day/month swap.
   The Tracker extracts Indian-invoice dates DAY-FIRST (DD/MM/YYYY,
   DD-MM-YYYY, DD.MM.YYYY — see the extraction prompt). A US-locale
   sheet silently re-reads "02/06/2026" as Feb-6 and stores the
   wrong serial; the ERP then faithfully reads Feb-6. Writing an
   explicit ISO string into a PLAIN-TEXT column removes every
   locale guess and gives the ERP one unambiguous value to parse.

   Direction (conservative — never loses data):
     • first part > 12  → it must be the DAY  (day-first)
     • second part > 12 → first part is the MONTH (US input)
     • otherwise        → assume DAY-first (Indian default)
   Returns the original string untouched if unparseable.
──────────────────────────────────────────────────────────────── */
function toIsoDate(val) {
  if (val === null || val === undefined) return '';
  // A real Date object (Sheets may hand one back) → format in IST
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? '' : Utilities.formatDate(val, 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  var s = String(val).trim();
  if (!s) return '';
  var pad = function(n) { return ('0' + n).slice(-2); };

  // Already ISO YYYY-MM-DD (optionally with a time component)
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    var mI = +iso[2], dI = +iso[3];
    if (mI >= 1 && mI <= 12 && dI >= 1 && dI <= 31) return iso[1] + '-' + pad(mI) + '-' + pad(dI);
    return s;
  }

  // Numeric DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (2- or 4-digit year)
  var num = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (num) {
    var a = +num[1], b = +num[2], yr = num[3];
    if (yr.length === 2) yr = '20' + pad(yr);
    var day, mon;
    if (a > 12)      { day = a; mon = b; }   // first can only be a day
    else if (b > 12) { mon = a; day = b; }   // second can only be a day → US input
    else             { day = a; mon = b; }   // ambiguous → Indian day-first
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return yr + '-' + pad(mon) + '-' + pad(day);
    return s;
  }

  // Named month: "2 June 2026", "02 Jun 2026", "June 2, 2026"
  var MON = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  var nm = s.toLowerCase().match(/(\d{1,2})\s+([a-z]{3,})\.?\s+(\d{4})/);
  if (!nm) nm = s.toLowerCase().match(/([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (nm) {
    var dd2, mm2, yy2;
    if (/^\d/.test(nm[1])) { dd2 = +nm[1]; mm2 = MON[nm[2].slice(0,3)]; yy2 = nm[3]; }
    else                   { mm2 = MON[nm[1].slice(0,3)]; dd2 = +nm[2]; yy2 = nm[3]; }
    if (mm2 && dd2 >= 1 && dd2 <= 31) return yy2 + '-' + pad(mm2) + '-' + pad(dd2);
  }
  return s; // unparseable — return as-is, never destroy data
}

function normaliseDate(val) {
  if (!val || val.trim() === '') return '';
  val = val.trim();
  // Already DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) return val;
  // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS (Flipkart format) → DD/MM/YYYY
  const m1 = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return m1[3]+'/'+m1[2]+'/'+m1[1];
  // DD-MM-YYYY → DD/MM/YYYY
  const m2 = val.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m2) return m2[1]+'/'+m2[2]+'/'+m2[3];
  // NN/NN/YYYY — DISAMBIGUATE day vs month. India uses DD/MM (day-first).
  // Only treat it as US MM/DD when the SECOND number is provably a day (>12)
  // and the first is a valid month. Otherwise KEEP day-first (Indian).
  // Fixes the bug where 04/06/2026 (4 June) was blindly swapped (→ wrong month).
  const m3 = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m3) {
    const a = +m3[1], b = +m3[2], yr = m3[3];
    const pad = n => ('0'+n).slice(-2);
    let day, mon;
    if (a > 12 && b <= 12)        { day = a; mon = b; }  // first can only be a day (Indian)
    else if (b > 12 && a <= 12)   { mon = a; day = b; }  // second can only be a day → US MM/DD
    else                          { day = a; mon = b; }  // ambiguous → Indian day-first
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return pad(day)+'/'+pad(mon)+'/'+yr;
    return val;
  }
  // DD.MM.YYYY (Amazon invoice format) — Indian day-first
  const m4 = val.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m4) return m4[1]+'/'+m4[2]+'/'+m4[3];
  return val;
}

/* ════════════════════════════════════════════════════════════
   ACTION: repairDates
   ─────────────────────────────────────────────────────────
   One-time repair for rows whose Invoice/Order/Ship dates were
   corrupted by the old normaliseDate bug (which blindly swapped
   day & month on NN/NN/YYYY, turning e.g. 04/06/2026 → 06/04/2026).

   Strategy: for each date cell, if the stored value looks like it
   was wrongly swapped, restore it using the ISO date that the
   "Saved On" timestamp implies is impossible to be future, AND by
   cross-checking against the original PDF is not available here —
   so we use a SAFE heuristic:

   We re-read the raw cell. If it is a Date object or DD/MM/YYYY
   string where BOTH parts <= 12 (ambiguous, the only case the old
   bug could corrupt), we leave it ALONE by default unless
   ?force=swap is passed, because we cannot know which way it was
   stored. Instead, the reliable repair is: re-run organizeSheets
   AFTER re-uploading the affected PDFs with the fixed code.

   HOWEVER, for the specific known-bad pattern this build targets,
   we expose a guided swap: pass e.parameter.swapRange = "A2:A10"
   style is overkill; simpler — we scan INVOICE_DATE, ORDER_DATE,
   SHIP_DATE and where the month currently reads as the WRONG value
   versus a provided correctMonth/correctYear filter, we swap.

   Simpler safe default (no params): report how many ambiguous rows
   exist so the user can decide. With ?apply=1&from=MM&to=DD it does
   the targeted swap only on rows whose invoice month == `from`.
════════════════════════════════════════════════════════════ */
function repairDates(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var apply = String(p.apply || '') === '1';
  var targetMonth = p.month ? +p.month : null;   // e.g. 4 to target rows showing April that should be June
  var targetYear  = p.year  ? +p.year  : null;

  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return respond({ status:'success', message:'No data rows.', scanned:0, fixed:0 });

  var dateCols = [C.INVOICE_DATE, C.ORDER_DATE, C.SHIP_DATE, C.EXP_DEL];
  var range = sheet.getRange(2, 1, lastRow - 1, HEADERS.length);
  var data  = range.getValues();
  var scanned = 0, fixed = 0, ambiguous = 0;
  var samples = [];

  function parts(v) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return { d: v.getDate(), m: v.getMonth() + 1, y: v.getFullYear() };
    }
    var s = String(v || '').trim();
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return { d: +m[1], m: +m[2], y: +m[3] };
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return { d: +m[3], m: +m[2], y: +m[1] };
    return null;
  }
  function fmt(d, m, y) {
    var pad = function(n){ return ('0'+n).slice(-2); };
    return pad(d) + '/' + pad(m) + '/' + y;
  }

  for (var i = 0; i < data.length; i++) {
    for (var c = 0; c < dateCols.length; c++) {
      var col = dateCols[c] - 1;
      var pp = parts(data[i][col]);
      if (!pp) continue;
      scanned++;
      // Only ambiguous dates (both <=12) could have been corrupted by the old swap.
      if (pp.d <= 12 && pp.m <= 12 && pp.d !== pp.m) {
        ambiguous++;
        // Targeted swap: if user says "rows currently showing month X should be the day"
        if (apply && targetMonth && pp.m === targetMonth && (!targetYear || pp.y === targetYear)) {
          var nd = pp.m, nm = pp.d;  // swap day<->month
          data[i][col] = fmt(nd, nm, pp.y);
          fixed++;
        } else if (samples.length < 20) {
          samples.push('Row ' + (i+2) + ' ' + HEADERS[col] + ' = ' + fmt(pp.d, pp.m, pp.y));
        }
      }
    }
  }

  if (apply && fixed > 0) {
    range.setValues(data);
    SpreadsheetApp.flush();
  }

  return respond({
    status: 'success',
    scanned: scanned,
    ambiguous: ambiguous,
    fixed: fixed,
    samples: samples,
    message: apply
      ? ('Swapped day/month on ' + fixed + ' cell(s).'
         + (targetMonth ? ' (targeted month=' + targetMonth + ')' : ''))
      : ('Scan complete. ' + ambiguous + ' ambiguous date cell(s) found (both day & month <= 12 — '
         + 'the only cells the old swap bug could corrupt). '
         + 'The 4-June invoices were stored as 2026-04-06 (month reads 04). '
         + 'To repair, call: ?action=repairDates&apply=1&month=4&year=2026 '
         + '— this swaps day<->month ONLY on cells whose month currently reads 04, '
         + 'turning 06/04/2026 back into 04/06/2026 (4 June). '
         + 'Review the samples list first to confirm before applying.')
  });
}

function findRowByOrderId(sheet, orderId, requireEmptyAWB) {
  if (!orderId) return null;
  const norm = normaliseId(orderId);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normaliseId(String(data[i][C.ORDER_ID-1])) === norm) {
      // If requireEmptyAWB, only match rows that have no AWB yet
      // This prevents collisions on Meesho _1/_2 sub-orders (which have AWBs)
      if (requireEmptyAWB) {
        const existingAWB = String(data[i][C.AWB-1]||'').trim();
        if (existingAWB) continue; // skip rows that already have an AWB
      }
      return i + 1;
    }
  }
  return null;
}

// Normalise IDs for comparison — strip spaces and lowercase only
// Do NOT strip _1/_2 suffixes — that causes Meesho sub-order false matches
function normaliseId(val) {
  var s = String(val || '')
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff\u2060]/g, '')  // strip hidden/non-breaking chars
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');  // collapse all whitespace
  // Flipkart/Shopsy ONLY: on the tax invoice the Order ID is printed glued to
  // the Invoice No (e.g. od337737259727708100-lwacjic270000291, or with no
  // separator at all). That trailing text is NOT part of the order key — it is
  // the same single package — so collapse any "od"+15-22 digits value to that
  // bare base. This makes the OrderID dedup tiers (and the Remove Duplicates
  // grouping) treat the bare and invoice-suffixed forms as ONE order.
  // The "^od\d{15,22}" guard matches ONLY Flipkart/Shopsy IDs: Meesho order
  // numbers are purely numeric (no "od" prefix, so their _1/_2 sub-orders stay
  // distinct), and AWBs / invoice numbers never start with "od"+digits — all
  // are left exactly as they were.
  s = s.replace(/^(od\d{15,22}).*$/, '$1');
  return s;
}

// Flipkart/Shopsy: collapse an Order ID that has the Invoice No glued onto it
// (OD…-INVOICE, or glued with no separator) down to the bare "OD"+digits base,
// preserving case for storage/display. No-op for every other platform's IDs
// (they never start with "OD"+15-22 digits), so Meesho/Amazon are untouched.
function collapseFkOrderId(val) {
  var s = String(val == null ? '' : val).trim();
  var m = s.match(/^OD\d{15,22}/i);
  return m ? m[0] : s;
}

/* Find existing row by Invoice Number — catches cases where Order ID format
   differs between import sources (e.g. Amazon Bazaar vs regular Amazon) */
function findRowByInvoiceNo(sheet, invoiceNo) {
  if (!invoiceNo || invoiceNo.trim() === '') return null;
  const norm = normaliseId(invoiceNo);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normaliseId(String(data[i][C.INVOICE_NO-1])) === norm) return i + 1;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────
   MERGE ROW — updates an existing sheet row with new data
   Only overwrites empty cells; always updates status + tracking
   Used by BOTH confirmPackage and importReport
──────────────────────────────────────────────────────────── */
/* ════════════════════════════════════════════════════════════
   MERGE ROW — updates an existing sheet row with new data.

   forceUpdate = true  → PDF upload mode: ALWAYS overwrite with
                          new non-empty value (corrects wrong AWB,
                          wrong Invoice No, etc.)
   forceUpdate = false → CSV import mode: only fill empty cells
                          (does not overwrite existing good data)
════════════════════════════════════════════════════════════ */
function mergeRow(sheet, rowIndex, newData, now, forceUpdate) {
  const existing = sheet.getRange(rowIndex, 1, 1, HEADERS.length).getValues()[0];

  const upd = function(col, newVal) {
    const v = newVal && String(newVal).trim() ? String(newVal).trim() : null;
    if (!v) return; // never write empty/null
    const cur = String(existing[col - 1] || '').trim();
    if (forceUpdate || !cur || cur === '—') {
      // forceUpdate: always write (PDF correcting wrong AWB/Invoice)
      // otherwise: only fill empty or placeholder cells
      sheet.getRange(rowIndex, col).setValue(newVal);
    }
  };

  upd(C.PLATFORM,    newData.platform);
  upd(C.COURIER,     newData.courier);
  upd(C.ORDER_ID,    newData.orderId);
  upd(C.AWB,         newData.awb);
  upd(C.INVOICE_NO,  newData.invoiceNumber);
  upd(C.INVOICE_DATE,toIsoDate(newData.invoiceDate));
  upd(C.ORDER_DATE,  toIsoDate(newData.orderDate));
  upd(C.BUYER_NAME,  newData.buyerName);
  upd(C.BUYER_PHONE, newData.buyerPhone);
  upd(C.SHIP_ADDR,   newData.shippingAddress);
  upd(C.BILL_ADDR,   newData.billingAddress || newData.shippingAddress);
  upd(C.PINCODE,     newData.pincode);
  upd(C.PRODUCTS,    newData.products);
  upd(C.QTY,         newData.qty);
  upd(C.AMOUNT,      newData.amount);
  upd(C.PAY_TYPE,    newData.paymentType);
  upd(C.SHIP_DATE,   toIsoDate(newData.shipDate));
  upd(C.EXP_DEL,     toIsoDate(newData.expectedDelivery));
  upd(C.TRACK_URL,   newData.trackUrl || getTrackingUrl(newData.courier, newData.awb, newData.orderId));

  // Always update status if new status is more specific than current
  const curStatus = String(existing[C.STATUS - 1] || '').trim();
  const newStatus = String(newData.status || '').trim();
  if (newStatus && isMoreSpecificStatus(newStatus, curStatus)) {
    sheet.getRange(rowIndex, C.STATUS    ).setValue(newStatus);
    sheet.getRange(rowIndex, C.STATUS_DTL).setValue(newData.statusDetail || '');
  }
  sheet.getRange(rowIndex, C.LAST_TRACKED).setValue(now);
}

// Returns true if newStatus is more informative than curStatus
function isMoreSpecificStatus(newS, curS) {
  const rank = {
    '': 0, 'Unknown': 0, 'Pending': 1, 'Shipped': 1,
    'In Transit': 2, 'Out for Delivery': 3,
    'Not Delivered': 4, 'Stuck at Hub': 4,
    'Rejected': 5, 'Delivered': 5,
    'Cancelled': 5, 'RTO Initiated': 5,
    'Lost in Transit': 5, 'RTO Delivered': 6
  };
  return (rank[newS] || 1) >= (rank[curS] || 0);
}

function buildReportPrompt(csv, reportType, fileName) {
  const fileHint = fileName ? ' File: ' + fileName : '';
  return `You are an expert at parsing Indian eCommerce seller reports from Amazon, Flipkart, Meesho, ShopClues, Shopsy.

Analyze this ${reportType} report${fileHint} and extract ALL orders. Return ONLY a valid JSON array of order objects.

Each order object must have these fields (use "" if not found):
{
  "platform": "Amazon|Amazon Bazaar|Flipkart|Shopsy|Meesho|ShopClues|IBI Website",
  "orderId": "order ID or order number",
  "awb": "AWB or tracking number",
  "invoiceNumber": "invoice number if present",
  "buyerName": "customer name",
  "buyerPhone": "phone number",
  "shippingAddress": "delivery address",
  "pincode": "6-digit PIN",
  "products": "product name or SKU",
  "qty": "quantity",
  "amount": "order amount digits only",
  "paymentType": "COD or Prepaid",
  "shipDate": "DD/MM/YYYY if available",
  "expectedDelivery": "DD/MM/YYYY if available",
  "status": "Delivered|Shipped|In Transit|Out for Delivery|RTO|Cancelled|Pending",
  "statusDetail": "any additional status detail"
}
Return ONLY the JSON array. No markdown. No explanation.

Report content:
` + csv;
}

function extractReportWithGemini(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  Utilities.sleep(2000);
  const body = { contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.05,maxOutputTokens:8192} };
  const res    = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='+apiKey,
    {method:'POST',contentType:'application/json',payload:JSON.stringify(body),muteHttpExceptions:true});
  const result = JSON.parse(res.getContentText());
  if (result.error) {
    const msg = result.error.message || '';
    if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate')) throw new Error('Gemini quota exceeded');
    throw new Error('Gemini: ' + msg);
  }
  if (!result.candidates || !result.candidates.length) throw new Error('Gemini returned no output');
  const text = result.candidates[0].content.parts[0].text.replace(/```json|```/g,'').trim();
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Gemini did not return an array');
  return parsed;
}

function extractReportWithOpenAI(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const body = { model:'gpt-4o', messages:[{role:'user',content:prompt}], max_tokens:8192, temperature:0.05 };
  const res    = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions',
    {method:'POST',contentType:'application/json',headers:{'Authorization':'Bearer '+apiKey},payload:JSON.stringify(body),muteHttpExceptions:true});
  const result = JSON.parse(res.getContentText());
  if (result.error) throw new Error('OpenAI: ' + result.error.message);
  const text = result.choices[0].message.content.replace(/```json|```/g,'').trim();
  return JSON.parse(text);
}

function extractReportWithClaude(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set');
  const body = { model:'claude-sonnet-4-6', max_tokens:8192, messages:[{role:'user',content:prompt}] };
  const res    = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',
    {method:'POST',contentType:'application/json',headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01'},payload:JSON.stringify(body),muteHttpExceptions:true});
  const result = JSON.parse(res.getContentText());
  if (result.error) throw new Error('Claude: ' + result.error.message);
  const text = result.content[0].text.replace(/```json|```/g,'').trim();
  return JSON.parse(text);
}

/* ════════════════════════════════════════════════════════════
   DEEPSEEK REPORT EXTRACTION  (text-only)
   DeepSeek's API is OpenAI-compatible. It reads TEXT, not PDFs,
   so it is wired into the CSV/report flow only — NOT into the
   PDF extractOnly chain (which needs native PDF/vision input).
   Model: deepseek-v4-flash  (stable name; replaces the legacy
   'deepseek-chat' alias that retires 2026-07-24).
   Pricing: ~$0.14 / 1M input tokens — by far the cheapest path
   for bulk report parsing. New accounts get 5M free tokens.
════════════════════════════════════════════════════════════ */
function extractReportWithDeepSeek(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
  const body = { model:'deepseek-v4-flash', messages:[{role:'user',content:prompt}], max_tokens:8192, temperature:0.05 };
  const res    = UrlFetchApp.fetch('https://api.deepseek.com/chat/completions',
    {method:'POST',contentType:'application/json',headers:{'Authorization':'Bearer '+apiKey},payload:JSON.stringify(body),muteHttpExceptions:true});
  const result = JSON.parse(res.getContentText());
  if (result.error) throw new Error('DeepSeek: ' + (result.error.message || JSON.stringify(result.error)));
  if (!result.choices || !result.choices.length) throw new Error('DeepSeek returned no output');
  const text = result.choices[0].message.content.replace(/```json|```/g,'').trim();
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('DeepSeek did not return an array');
  return parsed;
}


/* ════════════════════════════════════════════════════════════
   ACTION: testTracking — diagnose tracking for a given AWB
════════════════════════════════════════════════════════════ */
function testTracking(e) {
  const awb = (e.parameter.awb || '').trim();
  if (!awb) return respond({ status:'error', message:'No AWB' });

  const results = {};
  const TM_KEY  = 'fksgh89m-1ard-0i28-uam8-dxzrlfoi4qks';
  const tmHeaders = { 'Tracking-Api-Key': TM_KEY, 'Content-Type': 'application/json' };

  // Test TrackingMore — register then GET
  try {
    // First register
    const reg = UrlFetchApp.fetch('https://api.trackingmore.com/v4/trackings/create', {
      method: 'POST', headers: tmHeaders,
      payload: JSON.stringify({ tracking_number: awb, courier_code: 'delhivery' }),
      muteHttpExceptions: true
    });
    results.tm_register_code = reg.getResponseCode();
    results.tm_register_body = reg.getContentText().substring(0, 300);

    // Wait then GET
    Utilities.sleep(4000);
    const get = UrlFetchApp.fetch(
      'https://api.trackingmore.com/v4/trackings/get?tracking_numbers=' + encodeURIComponent(awb) + '&courier_code=delhivery',
      { method: 'GET', headers: tmHeaders, muteHttpExceptions: true }
    );
    results.tm_get_code = get.getResponseCode();
    results.tm_get_body = get.getContentText().substring(0, 800);
  } catch(e) { results.tm_error = e.message; }

  // Test Shiprocket login
  try {
    const token = getShiprocketToken();
    results.shiprocket_login = token ? 'SUCCESS — token obtained' : 'FAILED — no credentials or login error';

    if (token) {
      const url = 'https://apiv2.shiprocket.in/v1/external/courier/track/awb/' + encodeURIComponent(awb);
      const res = UrlFetchApp.fetch(url, {
        method:'GET', headers:{'Authorization':'Bearer '+token},
        muteHttpExceptions:true
      });
      results.shiprocket_track_code = res.getResponseCode();
      results.shiprocket_track_body = res.getContentText().substring(0, 600);
    }
  } catch(err) { results.shiprocket_error = err.message; }

  // Test Delhivery Merchant API — try all formats
  const delKey = PropertiesService.getScriptProperties().getProperty('DELHIVERY_API_KEY');
  results.delhivery_key_set = !!delKey;
  if (delKey) {
    // Format 1: Token header
    try {
      const r1 = UrlFetchApp.fetch('https://track.delhivery.com/api/v1/packages/json/?waybill='+encodeURIComponent(awb),
        { muteHttpExceptions:true, headers:{'Authorization':'Token '+delKey,'Accept':'application/json'} });
      results.del_format1_code = r1.getResponseCode();
      results.del_format1_body = r1.getContentText().substring(0, 300);
    } catch(e) { results.del_format1_err = e.message; }
    // Format 2: token in URL
    try {
      const r2 = UrlFetchApp.fetch('https://track.delhivery.com/api/v1/packages/json/?waybill='+encodeURIComponent(awb)+'&token='+encodeURIComponent(delKey),
        { muteHttpExceptions:true });
      results.del_format2_code = r2.getResponseCode();
      results.del_format2_body = r2.getContentText().substring(0, 300);
    } catch(e) { results.del_format2_err = e.message; }
  }

  return respond({ status:'success', debug: results });
}

/* ════════════════════════════════════════════════════════════
   SHEET HELPERS
════════════════════════════════════════════════════════════ */
function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    // Create fresh sheet
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // Always verify headers — update if blank or wrong column count
  const lastCol   = sheet.getLastColumn();
  const lastRow   = sheet.getLastRow();
  const needsHdr  = lastRow === 0 || lastCol !== HEADERS.length;

  if (needsHdr) {
    if (lastRow === 0) {
      sheet.appendRow(HEADERS);
    } else {
      // Sheet has data but wrong headers — rewrite header row only
      // First extend columns if needed
      if (lastCol < HEADERS.length) {
        sheet.insertColumnsAfter(lastCol, HEADERS.length - lastCol);
      }
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
  }

  // Always apply header styling
  const hdr = sheet.getRange(1, 1, 1, HEADERS.length);
  hdr.setBackground('#0D1B2A');
  hdr.setFontColor('#00D4F0');
  hdr.setFontWeight('bold');
  hdr.setFontSize(10);
  sheet.setFrozenRows(1);

  // Set column widths
  sheet.setColumnWidth(C.SHIP_ADDR,    260);
  sheet.setColumnWidth(C.BILL_ADDR,    260);
  sheet.setColumnWidth(C.PRODUCTS,     380);  // wider — full product name visible
  sheet.setColumnWidth(C.STATUS_DTL,   220);
  sheet.setColumnWidth(C.TRACK_URL,    200);
  sheet.setColumnWidth(C.INVOICE_DATE, 120);
  sheet.setColumnWidth(C.ORDER_DATE,   120);
  sheet.setColumnWidth(C.SHIP_DATE,    120);
  sheet.setColumnWidth(C.EXP_DEL,      120);

  // Force text format on ID/number columns to prevent scientific notation
  // on large Meesho/Flipkart order IDs and AWB numbers
  sheet.getRange(1, C.ORDER_ID, sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.AWB,      sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.BUYER_PHONE, sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.PINCODE,  sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.INVOICE_NO, sheet.getMaxRows(), 1).setNumberFormat('@STRING@');

  // Force PLAIN-TEXT on the four date columns so the sheet's locale can
  // NEVER re-interpret an ISO date string (the DD/MM ↔ MM/DD swap bug).
  // Combined with toIsoDate() at write time, this is the permanent fix.
  sheet.getRange(1, C.INVOICE_DATE, sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.ORDER_DATE,   sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.SHIP_DATE,    sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  sheet.getRange(1, C.EXP_DEL,      sheet.getMaxRows(), 1).setNumberFormat('@STRING@');

  return sheet;
}

function findRowByAWB(sheet, awb, incomingInvoiceNo) {
  if (!awb) return null;
  const norm    = normaliseId(awb);
  const normNew = normaliseId(incomingInvoiceNo || '');
  const data    = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normaliseId(String(data[i][C.AWB-1])) === norm) {
      // Safety: if both the incoming InvoiceNo and the existing row's InvoiceNo
      // are present but DIFFERENT, this is an AI AWB confusion collision.
      // Two distinct invoices cannot legitimately share one AWB.
      // Skip — do not overwrite a different order's row just because AWBs match.
      const existingInv = normaliseId(String(data[i][C.INVOICE_NO-1] || ''));
      if (normNew && existingInv && normNew !== existingInv) {
        Logger.log('findRowByAWB SKIP: AWB collision — incoming inv=' + normNew
                   + ' existing inv=' + existingInv + ' awb=' + norm);
        continue;
      }
      return i + 1;
    }
  }
  return null;
}

function timestamp() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm:ss');
}

/* ════════════════════════════════════════════════════════════
   TRACKING URL BUILDER
   Returns the most specific external link for each courier.
   For eKart — uses current status to land on the exact Flipkart page.
   Optional 4th param `status` makes Flipkart URL context-aware.
════════════════════════════════════════════════════════════ */
function getTrackingUrl(courier, awb, orderId, status) {
  if (!awb && !orderId) return '';

  if (courier === 'Amazon Transportation Services') {
    if (orderId) return 'https://sellercentral.amazon.in/orders-v3/order/' + encodeURIComponent(orderId);
    if (awb)     return 'https://track.amazon.in/tracking/' + encodeURIComponent(awb);
    return '';
  }

  if (courier === 'eKart Logistics') {
    // ekartlogistics.com is a blank SPA — unusable.
    // Flipkart Seller Hub hash routes — confirmed working from live screenshots:
    //   In Transit  → #dashboard/my-orders?...&orderState=shipments_in_transit
    //   Delivered   → #dashboard/my-orders?...&orderState=shipments_delivered
    //   Returns/RTO → #dashboard/returnsV2?tab=all_returns&state=all
    return getFlipkartUrlByStatus(status || '');
  }

  if (courier === 'Delhivery') {
    // delhivery.com/track-v2/package/{AWB} confirmed working from screenshots
    if (awb) return 'https://www.delhivery.com/track-v2/package/' + encodeURIComponent(awb);
    return '';
  }

  return '';
}

/* Returns the exact Flipkart Seller Hub page for the given shipment status */
function getFlipkartUrlByStatus(status) {
  const BASE   = 'https://seller.flipkart.com/index.html#dashboard/';
  const ORDERS = BASE + 'my-orders?serviceProfile=seller-fulfilled&shipmentType=easy-ship';
  const s = (status || '').toLowerCase();

  // Delivered → Completed Orders tab
  if (s === 'delivered' || (s.includes('delivered') && !s.includes('rto')))
    return ORDERS + '&orderState=shipments_delivered';

  // RTO / Returns / Rejected / Cancelled → Returns page
  if (s.includes('rto') || s === 'rejected' || s === 'cancelled' ||
      (s.includes('return') && !s.includes('return approved')))
    return BASE + 'returnsV2?tab=all_returns&state=all';

  // In Transit / Shipped / Out for Delivery / Not Delivered / Pending → Dispatched Orders tab
  return ORDERS + '&orderState=shipments_in_transit';
}

function respond(obj) {
  if (!obj.status) obj.status = 'success';
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ════════════════════════════════════════════════════════════
   MASTER COURIER DISPATCHER
   Routes to the correct courier tracker and normalises result.
   Returns null if no live data found — callers must handle null
   by keeping the existing sheet status, NOT defaulting to In Transit.
════════════════════════════════════════════════════════════ */
function trackCourier(awb, courier, ctx) {
  if (!awb) return null;
  awb = String(awb).trim();
  try {
    let result;
    if (courier === 'Delhivery')                          result = trackDelhivery(awb);
    else if (courier === 'Amazon Transportation Services') result = trackAmazon(awb);
    else if (courier === 'eKart Logistics')               result = trackEkart(awb);
    else result = null;

    if (result && result.status) {
      result.status = normaliseStatus(result.status);
      return result;   // faithful to the carrier — status is not second-guessed
    }
    // null means all APIs failed — caller keeps existing status
    return null;
  } catch (err) {
    Logger.log('trackCourier error for ' + courier + ' AWB ' + awb + ': ' + err.message);
    return null;
  }
}

/* ── DELHIVERY ── */
/* ════════════════════════════════════════════════════════════
   17TRACK API — Universal courier tracking
   Supports Delhivery (3604), eKart (3308), and 2000+ couriers
   Free: 100 calls/month. Register at https://account.17track.net/
   Store key in Script Properties as TRACK17_API_KEY
════════════════════════════════════════════════════════════ */
function trackWith17track(awb, carrierCode) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('TRACK17_API_KEY');
  if (!apiKey) return null;

  // Step 1: Register tracking number
  try {
    UrlFetchApp.fetch('https://api.17track.net/track/v2/register', {
      method: 'POST',
      contentType: 'application/json',
      headers: { '17token': apiKey },
      payload: JSON.stringify([{ number: awb, carrier: carrierCode }]),
      muteHttpExceptions: true
    });
  } catch(e) { Logger.log('17track register: ' + e.message); }

  // Step 2: Get tracking info
  try {
    const res = UrlFetchApp.fetch('https://api.17track.net/track/v2/gettrackinfo', {
      method: 'POST',
      contentType: 'application/json',
      headers: { '17token': apiKey },
      payload: JSON.stringify([{ number: awb, carrier: carrierCode }]),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) return null;
    const data = JSON.parse(res.getContentText());
    Logger.log('17track response: ' + JSON.stringify(data).substring(0, 300));

    if (!data.data || !data.data.accepted || !data.data.accepted.length) return null;

    const pkg    = data.data.accepted[0];
    const track  = pkg.track || {};
    const events = (track.tracking && track.tracking.providers && track.tracking.providers.length > 0)
                 ? track.tracking.providers[0].events || []
                 : [];

    // Map 17track status codes → IBI canonical status
    const statusMap = {
      0:  'Pending',
      10: 'In Transit',
      20: 'In Transit',
      30: 'Not Delivered',    // attempted delivery
      35: 'Not Delivered',    // attempted delivery failed
      40: 'Delivered',
      50: 'Stuck at Hub',     // exception
      60: 'RTO Initiated',
      65: 'RTO Delivered',
      70: 'Rejected',         // refused by consignee
      80: 'Lost in Transit'
    };
    const statusCode   = track.e || 0;
    const statusStr    = statusMap[statusCode] || 'In Transit';
    const latestEvent  = events.length > 0 ? events[0] : null;

    const mappedEvents = events.map(function(ev) {
      return {
        time:     ev.a  || '',
        location: ev.c  || ev.d || '',
        status:   ev.z  || ev.e || '',
        detail:   ev.d  || ''
      };
    });

    return {
      status:        statusStr,
      statusDetail:  latestEvent ? (latestEvent.z || latestEvent.d || '') : '',
      lastLocation:  latestEvent ? (latestEvent.c || '') : '',
      lastEventTime: latestEvent ? (latestEvent.a || '') : '',
      events:        mappedEvents,
      origin:        track.b  || '',
      destination:   track.c  || '',
      expectedDate:  track.s  || ''
    };
  } catch(e) {
    Logger.log('17track gettrackinfo error: ' + e.message);
    return null;
  }
}

// 17track carrier codes
var CARRIER_17TRACK = {
  'Delhivery': 3604,
  'eKart Logistics': 3308,
  'Amazon Transportation Services': 100002
};

/* ════════════════════════════════════════════════════════════
   TRACKINGMORE API — Universal free tracking
   Supports Delhivery, eKart, Amazon India & 1200+ couriers
   Free: 100 trackings/month — any AWB regardless of origin
   Register: trackingmore.com → Dashboard → API Keys
   Store in Script Properties as TRACKINGMORE_API_KEY
════════════════════════════════════════════════════════════ */
function trackWithAfterShip(awb, courier) {
  // Now powered by TrackingMore (same interface, drop-in replacement)
  return trackWithTrackingMore(awb, courier);
}

function trackWithTrackingMore(awb, courier) {
  // TrackingMore API key — your own saved key takes priority; the shared
  // key is only a last resort (and likely rate-limited/expired).
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('TRACKINGMORE_API_KEY')
              || props.getProperty('AFTERSHIP_API_KEY')
              || 'fksgh89m-1ard-0i28-uam8-dxzrlfoi4qks'; // last-resort shared key
  if (!apiKey) return null;

  // Map courier name to TrackingMore courier code
  const courierMap = {
    'Delhivery':                     'delhivery',
    'eKart Logistics':               'ekart',
    'Amazon Transportation Services':'amazon-india-ats'
  };
  const courierCode = courierMap[courier] || 'delhivery';

  const headers = {
    'Tracking-Api-Key': apiKey,
    'Content-Type':     'application/json'
  };

  // Step 1: Create tracking (idempotent — safe to call multiple times)
  try {
    UrlFetchApp.fetch('https://api.trackingmore.com/v4/trackings/create', {
      method:  'POST',
      headers: headers,
      payload: JSON.stringify({ tracking_number: awb, courier_code: courierCode }),
      muteHttpExceptions: true
    });
    Utilities.sleep(1500); // Wait for TrackingMore to fetch data
  } catch(e) { Logger.log('TrackingMore create: ' + e.message); }

  // Step 2: Get tracking data — retry once (first fetch may be pending).
  // Sleeps kept short so reTrackAll over many rows stays under the 6-min cap.
  var tr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt === 1) Utilities.sleep(3000); // wait 3s on second attempt
      const res  = UrlFetchApp.fetch(
        'https://api.trackingmore.com/v4/trackings/get?tracking_numbers=' + encodeURIComponent(awb) + '&courier_code=' + courierCode,
        { method: 'GET', headers: headers, muteHttpExceptions: true }
      );
      const code = res.getResponseCode();
      const body = res.getContentText();
      Logger.log('TrackingMore GET attempt ' + (attempt+1) + ' code: ' + code + ' body: ' + body.substring(0, 500));

      if (code !== 200) continue;
      const data = JSON.parse(body);
      const items = (data.data && data.data.items) ? data.data.items
                  : (Array.isArray(data.data) ? data.data : []);
      if (!items || !items.length) continue;

      const candidate = items[0];
      const rawSt = (candidate.delivery_status || candidate.status || 'pending').toLowerCase();

      // If status is still "pending" and no trackinfo, retry
      const hasEvents = candidate.origin_info && candidate.origin_info.trackinfo
                     && candidate.origin_info.trackinfo.length > 0;
      if (rawSt === 'pending' && !hasEvents && attempt === 0) {
        Logger.log('TrackingMore: pending with no events — retrying after 3s');
        continue;
      }
      tr = candidate;
      break;
    } catch(e) {
      Logger.log('TrackingMore GET attempt ' + (attempt+1) + ' error: ' + e.message);
    }
  }

  try {
    if (!tr) {
      // TrackingMore registered but data not yet available — return partial with message
      return {
        status: null, // don't override sheet status
        statusDetail: 'TrackingMore is fetching from carrier. Try again in 1-2 minutes.',
        lastLocation: '', lastEventTime: '', origin: '', destination: '',
        expectedDate: '', events: [],
        updating: true
      };
    }

    // Map TrackingMore delivery_status codes → IBI canonical status
    const statusMap = {
      'delivered':        'Delivered',
      'transit':          'In Transit',
      'out_for_delivery': 'Out for Delivery',
      'failed_attempt':   'Not Delivered',
      'exception':        'Stuck at Hub',
      'pending':          'Shipped',
      'info_received':    'Shipped',
      'expired':          'Stuck at Hub',
      'undelivered':      'Not Delivered',
      'return_to_sender': 'RTO Initiated',
      'returned':         'RTO Delivered',
      'rejected':         'Rejected',
      'lost':             'Lost in Transit',
      'cancelled':        'Cancelled'
    };

    const rawStatus = tr.delivery_status || tr.status || 'pending';
    const status    = statusMap[rawStatus.toLowerCase()] || normaliseStatus(rawStatus);

    // Build timeline — TrackingMore uses origin_info.trackinfo or destination_info.trackinfo
    const originInfo  = tr.origin_info      || {};
    const destInfo    = tr.destination_info || {};
    // Combine both arrays (origin + destination legs) for full timeline
    const rawHistory  = (originInfo.trackinfo  || []).concat(destInfo.trackinfo || []);

    const latestEvent = tr.latest_event || '';
    const latestTime  = tr.latest_checkpoint_time || tr.updated_at || '';
    const latestLoc   = originInfo.location || destInfo.location || tr.destination_city || '';

    const events = rawHistory.map(function(ev) {
      // TrackingMore trackinfo fields differ by API version
      return {
        time:     ev.Date             || ev.date              || '',
        location: ev.Details          || ev.location          || '',
        status:   normaliseStatus(ev.StatusDescription || ev.CheckpointDeliveryStatus || ev.status || ''),
        detail:   ev.StatusDescription || ev.Details          || ev.description || ''
      };
    }).filter(function(ev) { return ev.status || ev.detail; });

    // If no events from trackinfo, use latest_event as single entry
    if (events.length === 0 && latestEvent) {
      events.push({
        time:     latestTime,
        location: latestLoc,
        status:   latestEvent,
        detail:   latestEvent
      });
    }

    // Get destination from consignee details if available
    const destCity = tr.destination_city
                  || (tr.consignee && tr.consignee.city ? tr.consignee.city : '')
                  || destInfo.location || '';

    Logger.log('TrackingMore SUCCESS: ' + status + ' events: ' + events.length + ' latest: ' + latestEvent);

    return {
      status:        status,
      statusDetail:  latestEvent || rawStatus,
      lastLocation:  latestLoc   || (events.length > 0 ? events[0].location : ''),
      lastEventTime: latestTime,
      origin:        originInfo.location || tr.origin_city   || '',
      destination:   destCity,
      expectedDate:  tr.expected_delivery || tr.estimated_delivery_date || '',
      events:        events
    };
  } catch(err) {
    Logger.log('TrackingMore parse error: ' + err.message);
    return null;
  }
}

/* ════════════════════════════════════════════════════════════
   PRE-REGISTER AWBs WITH TRACKINGMORE
   Called at import/save time so tracking data is ready when
   user clicks 📡 Track. Supports Delhivery AND eKart.
   TrackingMore free: 100/month. Upgrade for higher volume.
════════════════════════════════════════════════════════════ */
function preRegisterWithTrackingMore(awbList, courierCode) {
  const TM_KEY = PropertiesService.getScriptProperties().getProperty('TRACKINGMORE_API_KEY')
              || 'fksgh89m-1ard-0i28-uam8-dxzrlfoi4qks';
  if (!awbList || !awbList.length) return;
  const code    = courierCode || 'delhivery';
  const headers = { 'Tracking-Api-Key': TM_KEY, 'Content-Type': 'application/json' };

  // Batch in groups of 40 (TrackingMore limit)
  for (var i = 0; i < awbList.length; i += 40) {
    const batch = awbList.slice(i, i + 40).map(function(awb) {
      return { tracking_number: String(awb), courier_code: code };
    });
    try {
      const res = UrlFetchApp.fetch('https://api.trackingmore.com/v4/trackings/batch', {
        method: 'POST', headers: headers,
        payload: JSON.stringify({ trackings: batch }),
        muteHttpExceptions: true
      });
      Logger.log('Pre-registered ' + batch.length + ' AWBs [' + code + '] with TrackingMore: HTTP ' + res.getResponseCode());
      if (i + 40 < awbList.length) Utilities.sleep(500);
    } catch (e) {
      Logger.log('Pre-register batch error [' + code + ']: ' + e.message);
    }
  }
}

/* ════════════════════════════════════════════════════════════
   DELHIVERY MERCHANT API — Direct tracking with seller account
   Most reliable: works for ALL Delhivery shipments regardless
   of which platform (Meesho, ShopClues, IBI Website) created them
   API Key: app.delhivery.com → Settings → API → Copy Token
   Store in Script Properties as DELHIVERY_API_KEY
════════════════════════════════════════════════════════════ */
function trackWithDelhiveryMerchant(awb) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('DELHIVERY_API_KEY');
  if (!apiKey) return null;

  // Try multiple URL and auth formats — Delhivery uses different formats for different accounts
  const attempts = [
    // Format 1: Token in Authorization header (standard)
    {
      url:     'https://track.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(awb),
      headers: { 'Authorization': 'Token ' + apiKey, 'Accept': 'application/json' }
    },
    // Format 2: Token as query parameter
    {
      url:     'https://track.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(awb) + '&token=' + encodeURIComponent(apiKey),
      headers: { 'Accept': 'application/json' }
    },
    // Format 3: Token in header without "Token " prefix (some accounts)
    {
      url:     'https://track.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(awb),
      headers: { 'Authorization': apiKey, 'Accept': 'application/json' }
    },
    // Format 4: Different base URL
    {
      url:     'https://staging-express.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(awb),
      headers: { 'Authorization': 'Token ' + apiKey, 'Accept': 'application/json' }
    }
  ];

  for (var i = 0; i < attempts.length; i++) {
    try {
      var attempt = attempts[i];
      var res = UrlFetchApp.fetch(attempt.url, {
        method: 'GET',
        headers: attempt.headers,
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var text = res.getContentText();
      Logger.log('Delhivery attempt ' + (i+1) + ' code: ' + code + ' body: ' + text.substring(0, 300));

      if (code === 200) {
        var data = JSON.parse(text);
        if (!data.ShipmentData || !data.ShipmentData.length) {
          Logger.log('Delhivery attempt ' + (i+1) + ': no ShipmentData');
          continue;
        }
        var sh     = data.ShipmentData[0].Shipment;
        var status = sh.Status && sh.Status.Status ? mapDelhiveryStatus(sh.Status.Status) : null;
        if (!status) continue;

        var events = (sh.Scans || []).map(function(scan) {
          var d = scan.ScanDetail || {};
          return {
            time:     d.StatusDateTime  || '',
            location: d.ScannedLocation || '',
            status:   d.Scan            || '',
            detail:   d.Instructions    || ''
          };
        }).reverse();

        Logger.log('Delhivery tracking SUCCESS via attempt ' + (i+1) + ': ' + status);
        return {
          status:        status,
          statusDetail:  sh.Status.StatusType || sh.Status.Status || '',
          lastLocation:  sh.Status.City       || '',
          lastEventTime: sh.Status.StatusDateTime || '',
          origin:        sh.OriginCity        || '',
          destination:   sh.DestinationCity   || '',
          expectedDate:  sh.ExpectedDeliveryDate || '',
          events:        events
        };
      }
    } catch(err) {
      Logger.log('Delhivery attempt ' + (i+1) + ' error: ' + err.message);
    }
  }

  Logger.log('Delhivery Merchant API: all attempts failed for AWB ' + awb);
  return null;
}

/* ════════════════════════════════════════════════════════════
   SHIPROCKET TRACKING API
   Supports all Indian couriers: Delhivery, eKart, Xpressbees,
   DTDC, BlueDart, Amazon Shipping, etc.
   Token stored in Script Properties as SHIPROCKET_TOKEN
   Get token: Shiprocket Dashboard → Settings → API
════════════════════════════════════════════════════════════ */
function getShiprocketToken() {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('SHIPROCKET_EMAIL');
  const pass  = props.getProperty('SHIPROCKET_PASS');
  if (!email || !pass) return null;

  // Check if we have a cached token that's still fresh (valid 10 days, refresh after 9)
  const cached    = props.getProperty('SHIPROCKET_TOKEN');
  const cachedAt  = parseInt(props.getProperty('SHIPROCKET_TOKEN_TIME') || '0');
  const ninedays  = 9 * 24 * 60 * 60 * 1000;
  if (cached && cachedAt && (Date.now() - cachedAt) < ninedays) {
    return cached;
  }

  // Login to get fresh token
  try {
    const res = UrlFetchApp.fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({ email: email, password: pass }),
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (data.token) {
      props.setProperty('SHIPROCKET_TOKEN',      data.token);
      props.setProperty('SHIPROCKET_TOKEN_TIME', String(Date.now()));
      Logger.log('Shiprocket: new token obtained successfully');
      return data.token;
    }
    Logger.log('Shiprocket login failed: ' + JSON.stringify(data).substring(0,200));
    return null;
  } catch(err) {
    Logger.log('Shiprocket login error: ' + err.message);
    return null;
  }
}

function trackWithShiprocket(awb) {
  const token = getShiprocketToken();
  if (!token) return null;

  try {
    // Try primary endpoint
    const url = 'https://apiv2.shiprocket.in/v1/external/courier/track/awb/' + encodeURIComponent(awb);
    const res  = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    const raw  = res.getContentText();
    Logger.log('Shiprocket AWB track code: ' + code + ' body: ' + raw.substring(0, 500));

    if (code === 401) {
      // Token expired — clear cache and retry once
      PropertiesService.getScriptProperties().deleteProperty('SHIPROCKET_TOKEN');
      PropertiesService.getScriptProperties().deleteProperty('SHIPROCKET_TOKEN_TIME');
      Logger.log('Shiprocket token expired, cleared cache');
      return null;
    }
    if (code !== 200) return null;

    const data = JSON.parse(raw);

    // Handle both response formats Shiprocket uses
    const td         = data.tracking_data || data;
    const shipTrack  = td.shipment_track  || td.track_url ? [] : [];
    const activities = td.shipment_track_activities || td.activities || [];

    // Some AWBs return data directly in tracking_data
    let latest = null;
    if (td.shipment_track && td.shipment_track.length > 0) {
      latest = td.shipment_track[0];
    } else if (data.current_status) {
      // Direct format
      latest = data;
    }

    if (!latest && (!activities || !activities.length)) {
      Logger.log('Shiprocket: no tracking data in response — AWB may not be in Shiprocket system');
      return null;
    }

    const rawStatus = latest ? (latest.current_status || latest.status || '') : '';
    const status    = rawStatus ? mapShiprocketStatus(rawStatus) : null;

    // Only return if we got a real status
    if (!status || status === 'In Transit' && !rawStatus) return null;

    const events = activities.map(function(act) {
      return {
        time:     act.date       || act.created_at || '',
        location: act.location   || act.city       || '',
        status:   act.activity   || act.status     || '',
        detail:   act.description|| act.remark     || ''
      };
    }).filter(function(ev){ return ev.status || ev.detail; });

    return {
      status:        status,
      statusDetail:  rawStatus,
      lastLocation:  latest ? (latest.location || '') : '',
      lastEventTime: latest ? (latest.updated_at || '') : '',
      origin:        latest ? (latest.pickup_location || '') : '',
      destination:   latest ? (latest.destination    || '') : '',
      expectedDate:  latest ? (latest.expected_delivered_date || '') : '',
      events:        events
    };
  } catch(err) {
    Logger.log('Shiprocket tracking error: ' + err.message);
    return null;
  }
}

function mapShiprocketStatus(raw) {
  const v = (raw || '').toLowerCase().trim();
  // Delivered
  if (v.includes('delivered') && !v.includes('undelivered') && !v.includes('rto')) return 'Delivered';
  // Out for Delivery
  if (v.includes('out for delivery') || v.includes('ofd')) return 'Out for Delivery';
  // RTO Delivered
  if (v.includes('rto') && v.includes('delivered')) return 'RTO Delivered';
  if (v === 'returned') return 'RTO Delivered';
  // RTO Initiated
  if (v.includes('rto') || v.includes('return to origin')) return 'RTO Initiated';
  if (v.includes('returned') && !v.includes('delivered')) return 'RTO Initiated';
  // Rejected
  if (v.includes('reject') || v.includes('refused') || v.includes('consignee refused')) return 'Rejected';
  // Not Delivered
  if (v.includes('undelivered') || v.includes('ndr') || v.includes('failed') ||
      v.includes('not delivered') || v.includes('delivery attempt')) return 'Not Delivered';
  // Cancelled
  if (v.includes('cancel')) return 'Cancelled';
  // Lost
  if (v.includes('lost')) return 'Lost in Transit';
  // Stuck
  if (v.includes('exception') || v.includes('held') || v.includes('damaged')) return 'Stuck at Hub';
  // In Transit
  if (v.includes('in transit') || v.includes('transit')) return 'In Transit';
  // Shipped
  if (v.includes('dispatched') || v.includes('shipped') || v.includes('picked')) return 'Shipped';
  // Pending
  if (v.includes('pending') || v.includes('processing')) return 'Pending';
  return raw || 'In Transit';
}

/* ════════════════════════════════════════════════════════════
   DELHIVERY TRACKING — Full fallback chain
   Priority: TrackingMore → Direct API (no auth) → Merchant API
════════════════════════════════════════════════════════════ */
function trackDelhivery(awb) {
  if (!awb) return { status: 'Pending', statusDetail: '', lastLocation: '', lastEventTime: '' };

  // ── Method 1: TrackingMore (most reliable for Meesho/ShopClues shipments) ──
  try {
    const rTM = trackWithTrackingMore(awb, 'Delhivery');
    if (rTM && rTM.status && rTM.status !== 'In Transit' && rTM.status !== 'Shipped') {
      Logger.log('Delhivery via TrackingMore: ' + rTM.status);
      return rTM;
    }
    // Even In Transit is valid if we have events
    if (rTM && rTM.events && rTM.events.length > 0) {
      Logger.log('Delhivery via TrackingMore (with events): ' + rTM.status);
      return rTM;
    }
  } catch (e) { Logger.log('TrackingMore Delhivery: ' + e.message); }

  // ── Method 2: Direct Delhivery Public API (works without auth for many AWBs) ──
  try {
    const res = UrlFetchApp.fetch(
      'https://track.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(awb),
      {
        muteHttpExceptions: true,
        headers: {
          'Accept':       'application/json',
          'Content-Type': 'application/json',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Referer':      'https://www.delhivery.com/'
        }
      }
    );
    const code = res.getResponseCode();
    Logger.log('Delhivery public API HTTP: ' + code);
    if (code === 200) {
      const data = JSON.parse(res.getContentText());
      if (data.ShipmentData && data.ShipmentData.length > 0) {
        const sh = data.ShipmentData[0].Shipment;
        if (sh && sh.Status && sh.Status.Status) {
          const status = mapDelhiveryStatus(sh.Status.Status);
          const events = (sh.Scans || []).map(function(scan) {
            const d = scan.ScanDetail || {};
            return {
              time:     d.StatusDateTime  || '',
              location: d.ScannedLocation || '',
              status:   mapDelhiveryStatus(d.Scan || '') || d.Scan || '',
              detail:   d.Instructions   || d.Scan || ''
            };
          }).reverse();
          Logger.log('Delhivery public API: ' + status);
          return {
            status:        status,
            statusDetail:  sh.Status.Instructions || sh.Status.StatusType || sh.Status.Status || '',
            lastLocation:  sh.Status.City          || sh.OriginCity    || '',
            lastEventTime: sh.Status.StatusDateTime || '',
            origin:        sh.OriginCity || '',
            destination:   sh.DestinationCity || '',
            expectedDate:  sh.ExpectedDeliveryDate || '',
            events:        events
          };
        }
      }
    }
  } catch (e) { Logger.log('Delhivery public API error: ' + e.message); }

  // ── Method 3: Delhivery Merchant API (requires DELHIVERY_API_KEY) ──
  try {
    const rDel = trackWithDelhiveryMerchant(awb);
    if (rDel && rDel.status && rDel.status !== 'In Transit') {
      Logger.log('Delhivery Merchant API: ' + rDel.status);
      return rDel;
    }
    if (rDel && rDel.events && rDel.events.length > 0) return rDel;
  } catch (e) { Logger.log('Delhivery Merchant API: ' + e.message); }

  // ── Method 4: Shiprocket (if configured) ──
  try {
    const rSR = trackWithShiprocket(awb);
    if (rSR && rSR.status && rSR.status !== 'In Transit') {
      Logger.log('Shiprocket Delhivery: ' + rSR.status);
      return rSR;
    }
  } catch (e) { Logger.log('Shiprocket Delhivery: ' + e.message); }

  // ── Method 5: 17track (if configured) ──
  try {
    const r17 = trackWith17track(awb, 3604);
    if (r17 && r17.status && r17.status !== 'In Transit') {
      Logger.log('17track Delhivery: ' + r17.status);
      return r17;
    }
  } catch (e) { Logger.log('17track Delhivery: ' + e.message); }

  // ── All methods failed — return null so caller keeps the existing sheet status ──
  Logger.log('trackDelhivery: all methods failed for AWB ' + awb + ' — returning null');
  return null;
}


/* ════════════════════════════════════════════════════════════
   AMAZON ATS TRACKING — Full fallback chain
   Amazon pages require JS rendering so scraping is unreliable.
   TrackingMore (amazon-india-ats) is the most reliable method.
   Priority: TrackingMore → 17track → Shiprocket → Page scrape
════════════════════════════════════════════════════════════ */
function trackAmazon(awb) {
  if (!awb) return null;

  // ── Method 1: TrackingMore with amazon-india-ats courier code ──
  try {
    const rTM = trackWithTrackingMore(awb, 'Amazon Transportation Services');
    if (rTM && rTM.status && rTM.status !== 'In Transit' && rTM.status !== 'Shipped') {
      Logger.log('Amazon via TrackingMore: ' + rTM.status);
      return rTM;
    }
    if (rTM && rTM.events && rTM.events.length > 0) {
      Logger.log('Amazon via TrackingMore (with events): ' + rTM.status);
      return rTM;
    }
  } catch (e) { Logger.log('TrackingMore Amazon: ' + e.message); }

  // ── Method 2: 17track (carrier code 100002 = Amazon India) ──
  try {
    const r17 = trackWith17track(awb, 100002);
    if (r17 && r17.status && r17.status !== 'Not Found' && r17.status !== 'In Transit') {
      Logger.log('17track Amazon: ' + r17.status);
      return r17;
    }
    if (r17 && r17.events && r17.events.length > 0) return r17;
  } catch (e) { Logger.log('17track Amazon: ' + e.message); }

  // ── Method 3: Shiprocket (if credentials configured) ──
  try {
    const rSR = trackWithShiprocket(awb);
    if (rSR && rSR.status && rSR.status !== 'In Transit') {
      Logger.log('Shiprocket Amazon: ' + rSR.status);
      return rSR;
    }
  } catch (e) { Logger.log('Shiprocket Amazon: ' + e.message); }

  // ── Method 4: Amazon tracking page (limited — JS-rendered but try) ──
  try {
    const urls = [
      'https://track.amazon.in/tracking/' + encodeURIComponent(awb),
      'https://www.amazon.in/progress-tracker/package/?_encoding=UTF8&itemId=&orderId=' + encodeURIComponent(awb)
    ];
    for (const url of urls) {
      try {
        const res = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
            'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-IN,en;q=0.9'
          }
        });
        const html = res.getContentText();
        if (html.length > 500) {
          const result = parseWithAnyAI(html.substring(0, 8000), 'Amazon Transportation Services', awb);
          if (result && result.status !== 'In Transit' && result.status !== 'Stuck at Hub') {
            Logger.log('Amazon page scrape: ' + result.status);
            return result;
          }
        }
      } catch (e) { Logger.log('Amazon URL ' + url + ' failed: ' + e.message); }
    }
  } catch (e) { Logger.log('trackAmazon scrape error: ' + e.message); }

  // ── All methods failed — return null so caller keeps existing sheet status ──
  Logger.log('trackAmazon: all methods failed for AWB ' + awb + ' — returning null');
  return null;
}

/* ════════════════════════════════════════════════════════════
   EKART LOGISTICS TRACKING — Full fallback chain
   eKart is Flipkart's courier arm used for Flipkart + Shopsy
   Priority: TrackingMore → Shiprocket → 17track → Direct scrape
════════════════════════════════════════════════════════════ */
function trackEkart(awb) {
  if (!awb) return null;

  // ── Method 1: TrackingMore with ekart courier code ──
  try {
    const rTM = trackWithTrackingMore(awb, 'eKart Logistics');
    if (rTM && rTM.status && rTM.status !== 'In Transit' && rTM.status !== 'Shipped') {
      Logger.log('eKart via TrackingMore: ' + rTM.status);
      return rTM;
    }
    if (rTM && rTM.events && rTM.events.length > 0) {
      Logger.log('eKart via TrackingMore (with events): ' + rTM.status);
      return rTM;
    }
  } catch (e) { Logger.log('TrackingMore eKart: ' + e.message); }

  // ── Method 2: Shiprocket ──
  try {
    const rSR = trackWithShiprocket(awb);
    if (rSR && rSR.status && rSR.status !== 'In Transit') {
      Logger.log('Shiprocket eKart: ' + rSR.status);
      return rSR;
    }
    if (rSR && rSR.events && rSR.events.length > 0) return rSR;
  } catch (e) { Logger.log('Shiprocket eKart: ' + e.message); }

  // ── Method 3: 17track (carrier code 3308 = eKart) ──
  try {
    const r17 = trackWith17track(awb, 3308);
    if (r17 && r17.status && r17.status !== 'Not Found' && r17.status !== 'In Transit') {
      Logger.log('17track eKart: ' + r17.status);
      return r17;
    }
    if (r17 && r17.events && r17.events.length > 0) return r17;
  } catch (e) { Logger.log('17track eKart: ' + e.message); }

  // ── Method 4: eKart direct API ──
  try {
    const apiUrl = 'https://ekartlogistics.com/shipment-track?trackingId=' + encodeURIComponent(awb);
    const apiRes = UrlFetchApp.fetch(apiUrl, {
      muteHttpExceptions: true,
      headers: {
        'Accept':            'application/json, text/plain, */*',
        'X-Requested-With':  'XMLHttpRequest',
        'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Referer':           'https://ekartlogistics.com/'
      }
    });
    const text = apiRes.getContentText();
    Logger.log('eKart direct API HTTP: ' + apiRes.getResponseCode() + ' len: ' + text.length);
    if (text.length > 100) {
      const result = parseWithAnyAI(text.substring(0, 6000), 'eKart Logistics', awb);
      if (result && result.status && result.status !== 'In Transit') return result;
    }
  } catch (e) { Logger.log('eKart direct API: ' + e.message); }

  // ── Method 5: Flipkart internal tracking API ──
  try {
    const flipUrl = 'https://track.flipkart.com/v2/internal/' + encodeURIComponent(awb) + '/detail';
    const flipRes = UrlFetchApp.fetch(flipUrl, {
      muteHttpExceptions: true,
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (flipRes.getResponseCode() === 200) {
      const data = JSON.parse(flipRes.getContentText());
      if (data.trackingInfo || data.shipment) {
        const t = data.trackingInfo || data.shipment;
        return {
          status:        normaliseStatus(t.currentStatus || t.status || ''),
          statusDetail:  t.statusMessage || t.currentStatusMessage || '',
          lastLocation:  t.currentCity   || t.location || '',
          lastEventTime: t.lastUpdated   || ''
        };
      }
    }
  } catch (e) { Logger.log('Flipkart tracking API eKart: ' + e.message); }

  // ── All methods failed — return null so caller keeps existing sheet status ──
  Logger.log('trackEkart: all methods failed for AWB ' + awb + ' — returning null');
  return null;
}

/* ── PARSE WITH ANY AVAILABLE AI ──
   Tries all AI providers in order until one succeeds
   This ensures tracking works even if one AI has quota issues
═══════════════════════════════════════════════════════════ */
function parseWithAnyAI(content, courier, awb) {
  const props   = PropertiesService.getScriptProperties();
  const prompt  = buildTrackingPrompt(content, courier, awb);
  const empty   = { status:'In Transit', statusDetail:'No tracking data found', lastLocation:'', lastEventTime:'' };

  // 1. Try Gemini
  try {
    const key = props.getProperty('GEMINI_API_KEY');
    if (key) {
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature:0.05, maxOutputTokens:300 }
      };
      const res    = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='+key,
        { method:'post', contentType:'application/json', payload:JSON.stringify(payload), muteHttpExceptions:true });
      const data   = JSON.parse(res.getContentText());
      if (data.candidates && data.candidates.length > 0) {
        const text = data.candidates[0].content.parts[0].text.replace(/```json|```/g,'').trim();
        const parsed = JSON.parse(text);
        Logger.log('Gemini tracking result: ' + JSON.stringify(parsed));
        return parsed;
      }
    }
  } catch(e) { Logger.log('Gemini tracking parse failed: ' + e.message); }

  // 2. Try OpenAI
  try {
    const key = props.getProperty('OPENAI_API_KEY');
    if (key) {
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role:'user', content: prompt }],
        max_tokens: 300, temperature: 0.05
      };
      const res    = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions',
        { method:'POST', contentType:'application/json', headers:{'Authorization':'Bearer '+key}, payload:JSON.stringify(body), muteHttpExceptions:true });
      const result = JSON.parse(res.getContentText());
      if (result.choices && result.choices.length > 0) {
        const text = result.choices[0].message.content.replace(/```json|```/g,'').trim();
        const parsed = JSON.parse(text);
        Logger.log('OpenAI tracking result: ' + JSON.stringify(parsed));
        return parsed;
      }
    }
  } catch(e) { Logger.log('OpenAI tracking parse failed: ' + e.message); }

  // 3. Try Claude
  try {
    const key = props.getProperty('CLAUDE_API_KEY');
    if (key) {
      const body = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role:'user', content: prompt }]
      };
      const res    = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',
        { method:'POST', contentType:'application/json', headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}, payload:JSON.stringify(body), muteHttpExceptions:true });
      const result = JSON.parse(res.getContentText());
      if (result.content && result.content.length > 0) {
        const text = result.content[0].text.replace(/```json|```/g,'').trim();
        const parsed = JSON.parse(text);
        Logger.log('Claude tracking result: ' + JSON.stringify(parsed));
        return parsed;
      }
    }
  } catch(e) { Logger.log('Claude tracking parse failed: ' + e.message); }

  // 4. Try DeepSeek (text-only; ideal + cheap for tracking-page HTML)
  try {
    const key = props.getProperty('DEEPSEEK_API_KEY');
    if (key) {
      const body = {
        model: 'deepseek-v4-flash',
        messages: [{ role:'user', content: prompt }],
        max_tokens: 300, temperature: 0.05
      };
      const res    = UrlFetchApp.fetch('https://api.deepseek.com/chat/completions',
        { method:'POST', contentType:'application/json', headers:{'Authorization':'Bearer '+key}, payload:JSON.stringify(body), muteHttpExceptions:true });
      const result = JSON.parse(res.getContentText());
      if (result.choices && result.choices.length > 0) {
        const text = result.choices[0].message.content.replace(/```json|```/g,'').trim();
        const parsed = JSON.parse(text);
        Logger.log('DeepSeek tracking result: ' + JSON.stringify(parsed));
        return parsed;
      }
    }
  } catch(e) { Logger.log('DeepSeek tracking parse failed: ' + e.message); }

  return empty;
}

function buildTrackingPrompt(content, courier, awb) {
  return `You are analyzing a ${courier} tracking page for AWB/tracking number: ${awb}.
Extract the CURRENT delivery status from the page content below.

Return ONLY a valid JSON object (no markdown, no explanation):
{
  "status": "one of: Delivered | Out for Delivery | In Transit | Shipped | Pending | Not Delivered | RTO Initiated | RTO Delivered | Rejected | Stuck at Hub | Lost in Transit | Cancelled",
  "statusDetail": "the most recent tracking event description (plain text, under 120 chars)",
  "lastLocation": "city or hub name where package currently is",
  "lastEventTime": "date and time of last event if shown"
}

STATUS GUIDE:
- Delivered       → package successfully delivered to customer
- Out for Delivery→ with delivery executive today
- In Transit      → moving between hubs/cities
- Shipped         → picked up, initial scan done
- Pending         → not yet picked up
- Not Delivered   → delivery was attempted but failed (NDR, door locked, not home, etc.)
- RTO Initiated   → return to origin started
- RTO Delivered   → returned to seller/hub
- Rejected        → customer refused the package at door
- Stuck at Hub    → held, exception, misrouted, or delayed
- Lost in Transit → shipment lost
- Cancelled       → order cancelled before delivery

If no tracking information is found in the content, return:
{"status":"In Transit","statusDetail":"Tracking data not yet available","lastLocation":"","lastEventTime":""}

Page content:
` + content.substring(0, 5000);
}

/* ════════════════════════════════════════════════════════════
   DELHIVERY STATUS MAPPER
   Maps raw Delhivery API status strings → IBI canonical status
   Source: Delhivery API documentation + observed live values
════════════════════════════════════════════════════════════ */
function mapDelhiveryStatus(raw) {
  if (!raw) return 'In Transit';
  const v = raw.toLowerCase().trim();

  // ── DELIVERED ────────────────────────────────────────────
  if (v === 'delivered' || v === 'dl' || v === 'dlv') return 'Delivered';
  if (v.includes('delivered') && !v.includes('rto') && !v.includes('undeliver')) return 'Delivered';

  // ── OUT FOR DELIVERY ──────────────────────────────────────
  if (v === 'out for delivery' || v === 'ofd' || v === 'dispatched for delivery') return 'Out for Delivery';
  if (v.includes('out for del')) return 'Out for Delivery';

  // ── RTO DELIVERED ─────────────────────────────────────────
  if ((v.includes('rto') && v.includes('delivered')) || v === 'returned') return 'RTO Delivered';

  // ── RTO INITIATED ─────────────────────────────────────────
  if (v === 'rto' || v === 'return to origin' || v === 'rto initiated' ||
      v.includes('rto intransit') || v.includes('rto in transit') ||
      v.includes('rto out for delivery') || v.includes('return initiated') ||
      v.includes('return to shipper'))
    return 'RTO Initiated';
  if (v.includes('rto')) return 'RTO Initiated';

  // ── REJECTED ──────────────────────────────────────────────
  if (v === 'rejected' || v.includes('consignee refused') ||
      v.includes('shipment rejected') || v === 'refused by consignee')
    return 'Rejected';

  // ── NOT DELIVERED (NDR) ───────────────────────────────────
  if (v === 'undelivered' || v === 'ud' || v === 'ndr' ||
      v.includes('non delivery') || v.includes('ndr') ||
      v.includes('undelivered') || v.includes('failed delivery') ||
      v.includes('not delivered') || v.includes('delivery failed') ||
      v === 'door locked' || v === 'address not found' ||
      v === 'customer not available' || v === 'no attempt')
    return 'Not Delivered';

  // ── LOST ─────────────────────────────────────────────────
  if (v.includes('lost') || v === 'missing') return 'Lost in Transit';

  // ── STUCK / EXCEPTION ────────────────────────────────────
  if (v === 'exception' || v.includes('held') || v === 'damaged' ||
      v.includes('misrouted') || v === 'on hold') return 'Stuck at Hub';

  // ── CANCELLED ────────────────────────────────────────────
  if (v.includes('cancel')) return 'Cancelled';

  // ── IN TRANSIT ───────────────────────────────────────────
  if (v.includes('transit') || v === 'in-transit') return 'In Transit';
  if (v.includes('reached') || v.includes('arrived') || v.includes('forwarded')) return 'In Transit';

  // ── SHIPPED / PICKED ─────────────────────────────────────
  if (v.includes('manifested') || v.includes('pickup') || v === 'picked up' ||
      v === 'received' || v === 'recd' || v === 'booked' ||
      v.includes('dispatched') || v.includes('collected'))
    return 'Shipped';

  // ── PENDING ──────────────────────────────────────────────
  if (v === 'pending' || v === 'not picked up' || v === 'awaiting pickup') return 'Pending';

  return 'In Transit'; // Safe default for unknown Delhivery statuses
}

/* ════════════════════════════════════════════════════════════
   SHARED EXTRACTION PROMPT — improved with real PDF examples
════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
   SHARED EXTRACTION PROMPT — Multi-order aware
   Returns a JSON ARRAY — even for a single order.
   Handles PDFs containing 2, 3, or more orders in one file.
════════════════════════════════════════════════════════════ */
function getExtractionPrompt() {
  return `You are an expert at reading Indian eCommerce shipping labels and tax invoices from IBI (India Business International).

⚠️  CRITICAL — MULTI-ORDER PDFs:
This PDF may contain ONE order or MULTIPLE orders printed in a single file.
A PDF with multiple orders will have:
  • Multiple shipping label sections (each with its own AWB No., Order ID, buyer address)
  • Multiple tax invoice sections (each with its own Invoice No., Order ID, product details)
  • Pages are separated by a dashed cut-line (- - - - - -)

YOU MUST scan the ENTIRE PDF and extract EVERY order found.
Return a JSON ARRAY — one element per order — even if only 1 order exists.

PLATFORM IDENTIFICATION — follow these rules STRICTLY:
- "Amazon"       → Order number format "XXX-XXXXXXX-XXXXXXX", shows "amazon.in", "ATSPL", "Sold on: www.amazon.in", or "ASSPL"
- "Amazon Bazaar"→ Explicitly shows "Amazon Bazaar" text
- "Flipkart"     → Shows "Flipkart" name or logo, "E-Kart Logistics" as courier, Order ID starting with "OD" followed by long digits
- "Shopsy"       → Explicitly shows "Shopsy" branding
- "Meesho"       → Uses Delhivery courier WITH Meesho-style long numeric order numbers (15+ digits like 271191571486534592), invoice numbers like "u3hs9274", or shows "meesho.com". CRITICAL: Even if seller shows "India Business International" or "T SASIMURUGAN" — if the ORDER PLATFORM is Meesho, classify as "Meesho". Meesho labels show "Prepaid: Do not collect cash" or COD with Delhivery and long order numbers
- "ShopClues"    → Shows "ShopClues.com", "Powered by ShopClues", "Clues Network Pvt Ltd", "Fulfilled by ShopClues Velocity", or "shopclues" anywhere
- "IBI Website"  → ONLY if shows "indiabusinessinternational.online" as the ORDER SOURCE. The presence of "India Business International" as SELLER NAME alone does NOT mean IBI Website.

DATE FIELDS — extract ALL dates carefully:
- invoiceDate → Look for "Invoice Date" on the tax invoice. Amazon format: "Invoice Date : 04.04.2026" — convert DD.MM.YYYY dots to DD/MM/YYYY slashes.
- orderDate   → Look for "Order Date" on the invoice. Amazon format: "Order Date: 04.04.2026" — convert to DD/MM/YYYY. Often same as invoice date.
- shipDate    → Dispatch/ship date from the shipping label. Flipkart: "HBD: DD - MM" means Handle By Date (ship date).
- expectedDelivery → "CPD: DD - MM" on Flipkart labels = Committed Promise Date = expected delivery.

ADDRESS FIELDS — extract BOTH separately:
- shippingAddress → "Shipping Address", "Ship To", or "Shipping/Customer address" — where the package is delivered.
- billingAddress  → "Billing Address" or "Bill To" — buyer's registered billing address. If only one address shown, copy it to billingAddress too.

AWB / TRACKING NUMBER — Read the FILENAME HINT section at the end FIRST before searching for AWB.

AMAZON — 3 types, completely different AWB locations:

  TYPE 1 — IN- prefix (Easy Ship):
  ✅ This PDF HAS a Shipping Label page. The AWB is on the shipping label section.
  • TWO possible AWB formats — use WHICHEVER appears on THIS specific label:
    (a) TBA format   : "TBA" followed by 12 digits      — e.g. TBA012503781000
    (b) Numeric format: a 12–15 digit number near/below the main barcode,
        often labelled "AWB" or "AWB No."               — e.g. 369674341636
  • Return ONLY the number itself — do NOT include the word "AWB" in the value.
  • CRITICAL: Every PDF is independent. Use ONLY the AWB printed on THIS label.
    Do NOT reuse an AWB from another PDF you may have seen earlier.
  • ⚠️ NEVER use: Order Number (e.g. 408-1234567-8901234), Invoice Number (e.g. IN-254),
    Invoice Details (e.g. "TN-1506942195-2627"), or Payment Transaction ID as the AWB.

  TYPE 2 — MAA4- prefix (FBA Chennai):
  ❌ This PDF has NO Shipping Label. AWB is provided in the FILENAME HINT below.
  • ⚠️ MANDATORY: Set awb = the value stated in FILENAME HINT. Do not use any other number.
  • Do NOT use: Invoice Number (e.g. MAA4-1), Invoice Details, Order Number, or Transaction ID

  TYPE 3 — CJB1- prefix (FBA Coimbatore):
  ❌ This PDF has NO Shipping Label. AWB is provided in the FILENAME HINT below.
  • ⚠️ MANDATORY: Set awb = the value stated in FILENAME HINT. Do not use any other number.
  • Do NOT use: Invoice Number (e.g. CJB1-1, CJB1-2), Invoice Details (e.g. TN-CJB1-1506942195-2627),
    Order Number, or Payment Transaction ID as the AWB

FLIPKART AWB — number after "AWB No." label:
  • Format: FMPC... or FMPP... followed by 10 digits (e.g. FMPC5944720324)

MEESHO AWB — large standalone barcode number:
  • Format: 16-18 digit number (e.g. 1490830674678026)

SHOPCLUES AWB — number after "AWB No" label

⚠️  CRITICAL RULE: For FBA invoice-only types (MAA4-/CJB1-), the AWB field MUST equal
the number specified in the FILENAME HINT. It will NOT be found anywhere in the document body.

PAYMENT TYPE:
- "COD"     → "Cash on Delivery", "COD", "Please collect Rs."
- "Prepaid" → "Prepaid", "Do not collect cash", "AmazonPay", "UPI", online payment

Return ONLY a valid JSON ARRAY of objects. Each object has EXACTLY these keys (use "" if not found):
[
  {
    "platform": "Amazon|Amazon Bazaar|Flipkart|Shopsy|Meesho|ShopClues|IBI Website|Unknown",
    "orderId": "order number",
    "invoiceNumber": "invoice or bill number",
    "invoiceDate": "DD/MM/YYYY — invoice date",
    "orderDate": "DD/MM/YYYY — order or purchase date",
    "awb": "AWB or tracking number",
    "shipDate": "DD/MM/YYYY — ship or dispatch date",
    "expectedDelivery": "DD/MM/YYYY — expected delivery date",
    "buyerName": "recipient full name",
    "buyerPhone": "mobile number",
    "shippingAddress": "complete Ship To / delivery address",
    "billingAddress": "complete Bill To / billing address (copy shippingAddress if only one address shown)",
    "pincode": "6-digit PIN code of delivery address",
    "productName": "Full descriptive product name exactly as written on the invoice. IMPORTANT for FLIPKART/SHOPSY: the shipping label rarely shows the product — read the product description from the TAX INVOICE table further down the same PDF (the 'Description'/'Product'/'Title' column of the items table). Never leave this empty if any item description appears anywhere in the document.",
    "productSKU": "The ASIN, FSN, or SKU code only",
    "qty": "quantity as number only",
    "amount": "total invoice amount digits only, no ₹ symbol",
    "paymentType": "COD or Prepaid"
  }
]
Return ONLY the JSON array. No markdown backticks. No explanation. No extra text.
If 2 orders in PDF → return 2-element array. If 3 orders → 3-element array. Etc.`;}


/* ════════════════════════════════════════════════════════════
   LEGACY SINGLE-ORDER PROMPT (kept for AI fallback parsing)
════════════════════════════════════════════════════════════ */
function getExtractionPromptLegacy() {
  // Same content but explicitly asks for single object
  // Used as last-resort fallback if array parsing fails
  return getExtractionPrompt().replace(
    'Return ONLY a valid JSON ARRAY of objects.',
    'If only 1 order in PDF, return a single JSON OBJECT (not array) with EXACTLY these keys:'
  ).replace(
    /\[\s*\{/, '{'
  ).replace(
    /\}\s*\]/, '}'
  );
}

/* ════════════════════════════════════════════════════════════
   GEMINI EXTRACTION
════════════════════════════════════════════════════════════ */
function extractWithGemini(base64Pdf, fileHint) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set. Add it in AI Settings tab.');

  const prompt = getExtractionPrompt() + (fileHint || '');
  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type:'application/pdf', data: base64Pdf } }
    ]}],
    generationConfig: { temperature:0.05, maxOutputTokens:4096 }
  };

  Utilities.sleep(1500);
  const res    = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='+apiKey,
    { method:'POST', contentType:'application/json', payload:JSON.stringify(body), muteHttpExceptions:true });
  const result = JSON.parse(res.getContentText());

  if (result.error) {
    const msg = result.error.message || '';
    if (msg.includes('limit: 0') || msg.includes('billing') || msg.includes('RESOURCE_EXHAUSTED')) {
      PropertiesService.getScriptProperties().setProperty(
        'BROKEN_AIS',
        ((PropertiesService.getScriptProperties().getProperty('BROKEN_AIS') || '') + ',gemini')
          .split(',').filter(function(x,i,a){ return x && a.indexOf(x)===i; }).join(',')
      );
      Logger.log('Gemini marked as broken: ' + msg);
    }
    throw new Error('Gemini Error: ' + msg);
  }
  if (!result.candidates || result.candidates.length === 0) throw new Error('Gemini no output. Response: ' + JSON.stringify(result).substring(0,300));

  const text = result.candidates[0].content.parts[0].text.replace(/```json|```/g,'').trim();
  return JSON.parse(text);
}

/* ════════════════════════════════════════════════════════════
   OPENAI (GPT-4o) EXTRACTION
════════════════════════════════════════════════════════════ */
function extractWithOpenAI(base64Pdf, fileHint) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not set. Add it in AI Settings tab.');

  const pdfBlob = Utilities.newBlob(Utilities.base64Decode(base64Pdf), 'application/pdf', 'invoice.pdf');
  const upload  = UrlFetchApp.fetch('https://api.openai.com/v1/files', {
    method:'POST', headers:{'Authorization':'Bearer '+apiKey},
    payload:{ purpose:'user_data', file: pdfBlob }, muteHttpExceptions:true
  });
  const uploadData = JSON.parse(upload.getContentText());
  if (uploadData.error) throw new Error('OpenAI Upload: ' + uploadData.error.message);
  const fileId = uploadData.id;

  try {
    const prompt = getExtractionPrompt() + (fileHint || '');
    const body = {
      model: 'gpt-4o',
      messages: [{ role:'user', content: [
        { type:'text', text: prompt },
        { type:'file', file: { file_id: fileId } }
      ]}],
      max_tokens:4096, temperature:0.05
    };
    const res    = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions',
      { method:'POST', contentType:'application/json', headers:{'Authorization':'Bearer '+apiKey}, payload:JSON.stringify(body), muteHttpExceptions:true });
    const result = JSON.parse(res.getContentText());
    if (result.error) throw new Error('OpenAI: ' + result.error.message);
    if (!result.choices || !result.choices.length) throw new Error('OpenAI no output');
    const text = result.choices[0].message.content.replace(/```json|```/g,'').trim();
    return JSON.parse(text);
  } finally {
    try { UrlFetchApp.fetch('https://api.openai.com/v1/files/'+fileId, { method:'DELETE', headers:{'Authorization':'Bearer '+apiKey}, muteHttpExceptions:true }); } catch(e){}
  }
}

/* ════════════════════════════════════════════════════════════
   ANTHROPIC CLAUDE EXTRACTION
════════════════════════════════════════════════════════════ */
function extractWithClaude(base64Pdf, fileHint) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set. Add it in AI Settings tab.');

  const prompt = getExtractionPrompt() + (fileHint || '');
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role:'user', content: [
      { type:'document', source:{ type:'base64', media_type:'application/pdf', data: base64Pdf } },
      { type:'text', text: prompt }
    ]}]
  };
  const res    = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',
    { method:'POST', contentType:'application/json', headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01'}, payload:JSON.stringify(body), muteHttpExceptions:true });
  const result = JSON.parse(res.getContentText());
  if (result.error) throw new Error('Claude: ' + result.error.message);
  if (!result.content || !result.content.length) throw new Error('Claude no output');
  const text = result.content[0].text.replace(/```json|```/g,'').trim();
  return JSON.parse(text);
}

/* ════════════════════════════════════════════════════════════
   DEEPSEEK TEXT EXTRACTION  (PDF text layer → JSON)
   DeepSeek's API is TEXT-ONLY (no vision endpoint — it rejects
   image_url). The browser extracts the PDF's text layer via PDF.js
   and sends it as `pdfText`. DeepSeek reads that text and returns the
   same JSON the vision providers do. This keeps working when
   Gemini/Claude/OpenAI are out of quota — DeepSeek is cheap (5M free
   tokens, then ~$0.14/1M) with no hard rate limit.
════════════════════════════════════════════════════════════ */
function extractWithDeepSeekText(pdfText, fileHint) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set. Add it in AI Settings tab.');
  if (!pdfText || !pdfText.trim()) throw new Error('No PDF text supplied (the PDF may be a scanned image with no text layer).');

  const prompt = getExtractionPrompt() + (fileHint || '')
    + '\n\n--- BEGIN PDF TEXT CONTENT ---\n' + pdfText + '\n--- END PDF TEXT CONTENT ---';

  const body = {
    model: 'deepseek-v4-flash',
    messages: [{ role:'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.05
  };
  const res    = UrlFetchApp.fetch('https://api.deepseek.com/chat/completions',
    { method:'POST', contentType:'application/json', headers:{'Authorization':'Bearer '+apiKey}, payload:JSON.stringify(body), muteHttpExceptions:true });
  const result = JSON.parse(res.getContentText());
  if (result.error) throw new Error('DeepSeek: ' + (result.error.message || JSON.stringify(result.error)));
  if (!result.choices || !result.choices.length) throw new Error('DeepSeek no output');
  const text = result.choices[0].message.content.replace(/```json|```/g,'').trim();
  return JSON.parse(text);
}
