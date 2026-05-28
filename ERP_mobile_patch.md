# IBI ERP — Mobile Responsive CSS Patch
## Problem
On mobile the Orders table only shows 2–3 columns; critical fields
(Product, Total, Status, AWB) require horizontal scroll and are easy to miss.

## Fix
Add the CSS block below inside the `<style>` tag of `index.html`
(paste it just before the closing `</style>` tag).

Also add `data-label` attributes to each `<td>` in the orders table row
template so the card layout knows what to label each cell.

---

## STEP 1 — Add this CSS block to `<style>` (just before `</style>`)

```css
/* ═══════════════════════════════════════════════════════
   IBI ERP — Mobile-responsive Orders table
   Converts table rows to cards on screens ≤ 768 px.
   ═══════════════════════════════════════════════════════ */
@media (max-width: 768px) {

  /* Hide desktop table header */
  .orders-table thead,
  table[id*="order"] thead,
  .tbl-orders thead { display: none !important; }

  /* Each row becomes a self-contained card */
  .orders-table tbody tr,
  table[id*="order"] tbody tr,
  .tbl-orders tbody tr {
    display: block !important;
    margin: 0 0 14px 0 !important;
    padding: 14px 16px !important;
    border-radius: 14px !important;
    border: 1px solid var(--border, rgba(255,255,255,.1)) !important;
    background: var(--surface, rgba(255,255,255,.04)) !important;
    box-shadow: 0 2px 8px rgba(0,0,0,.18) !important;
  }

  /* Each cell becomes a label : value row */
  .orders-table tbody td,
  table[id*="order"] tbody td,
  .tbl-orders tbody td {
    display: flex !important;
    justify-content: space-between !important;
    align-items: flex-start !important;
    padding: 5px 0 !important;
    border: none !important;
    font-size: 13px !important;
    border-bottom: 1px solid rgba(255,255,255,.05) !important;
    min-height: 26px !important;
    gap: 10px !important;
  }

  .orders-table tbody td:last-child,
  .tbl-orders tbody td:last-child { border-bottom: none !important; }

  /* Column label shown before the value */
  .orders-table tbody td::before,
  .tbl-orders tbody td::before {
    content: attr(data-label);
    font-weight: 700;
    font-size: 11px;
    color: var(--muted, #8899aa);
    text-transform: uppercase;
    letter-spacing: .05em;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 100px;
    padding-top: 1px;
  }

  /* Value side: right-aligned, allows wrapping */
  .orders-table tbody td > *,
  .orders-table tbody td > span,
  .orders-table tbody td > a,
  .tbl-orders tbody td > * {
    text-align: right !important;
    word-break: break-word !important;
    max-width: 190px !important;
  }

  /* Hide less-critical columns on very small screens */
  @media (max-width: 420px) {
    td[data-label="COURIER"],
    td[data-label="STATE"],
    td[data-label="INVOICE DATE"] { display: none !important; }
  }

  /* Action buttons row — show as flex row */
  .orders-table tbody td.td-actions,
  .tbl-orders tbody td.td-actions {
    justify-content: flex-end !important;
    gap: 8px !important;
    flex-wrap: wrap !important;
  }
  .orders-table tbody td.td-actions::before,
  .tbl-orders tbody td.td-actions::before { display: none !important; }
}
```

---

## STEP 2 — Add `data-label` attributes to each `<td>` in the JS row builder

Find where order rows are rendered (search for `td` near `orderId` or `platform`).
Add `data-label="COLUMN NAME"` to each `<td>`. Example:

```html
<td data-label="ORDER ID">${order.id}</td>
<td data-label="INVOICE DATE">${order.date}</td>
<td data-label="PLATFORM">${badge}</td>
<td data-label="CUSTOMER">${order.customer}</td>
<td data-label="STATE">${state}</td>
<td data-label="PRODUCT">${productHtml}</td>
<td data-label="TOTAL">${totalFormatted}</td>
<td data-label="STATUS">${statusBadge}</td>
<td data-label="AWB / TRACK">${trackingHtml}</td>
<td data-label="COURIER">${courierName}</td>
<td class="td-actions" data-label="ACTIONS">${actionButtons}</td>
```

---

## Alternative quick fix (no data-label needed)
If adding data-labels to every td is complex, just add a horizontal scroll
wrapper around the table so mobile users can swipe through all columns,
but make the first two columns sticky:

```css
@media (max-width: 768px) {
  .orders-table-wrap,
  .table-container { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
  
  .orders-table th:nth-child(1),
  .orders-table td:nth-child(1) {
    position: sticky !important;
    left: 0 !important;
    z-index: 2 !important;
    background: var(--bg, #0d1b2a) !important;
  }
  .orders-table th:nth-child(2),
  .orders-table td:nth-child(2) {
    position: sticky !important;
    left: 120px !important;  /* adjust to match col-1 width */
    z-index: 2 !important;
    background: var(--bg, #0d1b2a) !important;
  }
}
```

---

## To apply: upload your ERP `index.html` in the next message
Claude will apply the patch directly to the file and give you the output.
