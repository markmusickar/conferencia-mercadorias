const conferencesKey = "conferencia-mercadorias-v2";
const draftKey = "conferencia-rascunho-v2";

const $ = (selector) => document.querySelector(selector);
const form = $("#itemForm");
const invoiceInput = $("#invoiceNumber");
const inspectorInput = $("#inspectorName");
const barcodeInput = $("#barcode");
const descriptionInput = $("#description");
const quantityInput = $("#quantity");
const photoInput = $("#photo");
const photoPreview = $("#photoPreview");
const draftItems = $("#draftItems");
const draftEmpty = $("#draftEmpty");
const itemTemplate = $("#itemTemplate");
const conferenceTemplate = $("#conferenceTemplate");
const conferenceList = $("#conferenceList");
const historyEmpty = $("#historyEmpty");
const searchInput = $("#conferenceSearch");
const startScanButton = $("#startScan");
const stopScanButton = $("#stopScan");
const barcodePhotoInput = $("#barcodePhoto");
const barcodeReader = $("#barcodeReader");
const scannerFallback = $("#scannerFallback");

let conferences = readJson(conferencesKey, []);
let draft = readJson(draftKey, { id: null, invoice: "", inspector: "", items: [], startedAt: new Date().toISOString() });
let editingItemId = null;
let currentPhoto = "";
let scanner = null;
let messageTimer = null;

migrateOldItems();
bindEvents();
syncDraftFields();
renderAll();

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  $("#goToNew").addEventListener("click", () => showView("new"));
  $("#newConference").addEventListener("click", startNewConference);
  $("#clearForm").addEventListener("click", resetItemForm);
  $("#saveConference").addEventListener("click", saveConference);
  invoiceInput.addEventListener("input", saveDraftHeader);
  inspectorInput.addEventListener("input", saveDraftHeader);
  photoInput.addEventListener("change", loadItemPhoto);
  form.addEventListener("submit", addOrUpdateItem);
  draftItems.addEventListener("click", handleDraftItemAction);
  conferenceList.addEventListener("click", handleConferenceAction);
  searchInput.addEventListener("input", renderHistory);
  startScanButton.addEventListener("click", startScanner);
  stopScanButton.addEventListener("click", stopScanner);
  barcodePhotoInput.addEventListener("change", scanCapturedPhoto);
}

function showView(name) {
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#newView").classList.toggle("active", name === "new");
  $("#historyView").classList.toggle("active", name === "history");
  if (name === "history") renderHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function saveDraftHeader() {
  draft.invoice = invoiceInput.value.trim();
  draft.inspector = inspectorInput.value.trim();
  persistDraft();
  updateDraftTitle();
}

async function loadItemPhoto() {
  const file = photoInput.files?.[0];
  currentPhoto = file ? await resizeImage(file) : "";
  renderPhotoPreview();
}

function addOrUpdateItem(event) {
  event.preventDefault();
  const barcode = barcodeInput.value.trim();
  const description = descriptionInput.value.trim();
  const quantity = Number(quantityInput.value);

  if (!barcode) return showMessage("#formStatus", "Informe ou leia o código de barras.", barcodeInput);
  if (!description) return showMessage("#formStatus", "Informe a descrição da mercadoria.", descriptionInput);
  if (!Number.isFinite(quantity) || quantity < 1) return showMessage("#formStatus", "Informe uma quantidade válida.", quantityInput);
  if (!currentPhoto) return showMessage("#formStatus", "Tire uma foto da mercadoria.", photoInput);

  const now = new Date().toISOString();
  if (editingItemId) {
    draft.items = draft.items.map((item) => item.id === editingItemId
      ? { ...item, barcode, description, quantity, photo: currentPhoto, updatedAt: now }
      : item);
  } else {
    draft.items.unshift({ id: makeId(), barcode, description, quantity, photo: currentPhoto, createdAt: now, updatedAt: now });
  }

  if (!persistDraft()) return;
  showMessage("#formStatus", editingItemId ? "Item atualizado." : "Item adicionado. Pronto para o próximo.");
  resetItemForm();
  renderDraft();
}

function handleDraftItemAction(event) {
  const button = event.target.closest("button");
  const card = event.target.closest(".item-card");
  if (!button || !card) return;
  const item = draft.items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;

  if (button.classList.contains("remove")) {
    if (!confirm(`Excluir ${item.description}?`)) return;
    draft.items = draft.items.filter((entry) => entry.id !== item.id);
    persistDraft();
    renderDraft();
  }

  if (button.classList.contains("edit")) {
    editingItemId = item.id;
    barcodeInput.value = item.barcode;
    descriptionInput.value = item.description;
    quantityInput.value = item.quantity;
    currentPhoto = item.photo;
    renderPhotoPreview();
    form.querySelector(".primary-action").textContent = "Salvar alteração";
    barcodeInput.focus();
  }
}

function saveConference() {
  saveDraftHeader();
  if (!draft.invoice) return showMessage("#conferenceStatus", "Informe o nome ou número da nota.", invoiceInput);
  if (!draft.inspector) return showMessage("#conferenceStatus", "Informe o nome do conferente.", inspectorInput);
  if (!draft.items.length) return showMessage("#conferenceStatus", "Adicione pelo menos um item à conferência.");

  const now = new Date().toISOString();
  const record = {
    ...draft,
    id: draft.id || makeId(),
    savedAt: now,
    updatedAt: now
  };
  const existingIndex = conferences.findIndex((entry) => entry.id === record.id);
  if (existingIndex >= 0) conferences[existingIndex] = record;
  else conferences.unshift(record);

  if (!writeJson(conferencesKey, conferences, "#conferenceStatus")) return;
  localStorage.removeItem(draftKey);
  draft = blankDraft();
  syncDraftFields();
  resetItemForm();
  renderAll();
  showView("history");
}

function startNewConference() {
  const hasContent = draft.invoice || draft.inspector || draft.items.length;
  if (hasContent && !confirm("Limpar a conferência atual e iniciar outra?")) return;
  draft = blankDraft();
  localStorage.removeItem(draftKey);
  syncDraftFields();
  resetItemForm();
  renderDraft();
}

function handleConferenceAction(event) {
  const button = event.target.closest("button");
  const card = event.target.closest(".conference-card");
  if (!button || !card) return;
  const conference = conferences.find((entry) => entry.id === card.dataset.id);
  if (!conference) return;

  if (button.classList.contains("open-conference")) openConference(conference);
  if (button.classList.contains("export-excel")) exportExcel(conference);
  if (button.classList.contains("export-pdf")) exportPdf(conference);
  if (button.classList.contains("delete-conference")) deleteConference(conference);
}

function openConference(conference) {
  const hasOtherDraft = (draft.invoice || draft.inspector || draft.items.length) && draft.id !== conference.id;
  if (hasOtherDraft && !confirm("Substituir o rascunho atual por esta conferência?")) return;
  draft = JSON.parse(JSON.stringify(conference));
  persistDraft();
  syncDraftFields();
  renderDraft();
  showView("new");
}

function deleteConference(conference) {
  if (!confirm(`Excluir definitivamente a conferência ${conference.invoice}?`)) return;
  conferences = conferences.filter((entry) => entry.id !== conference.id);
  writeJson(conferencesKey, conferences);
  renderAll();
}

async function exportExcel(conference) {
  if (!window.ExcelJS) {
    alert("O recurso de Excel não carregou. Verifique a internet e tente novamente.");
    return;
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Conferência", { views: [{ state: "frozen", ySplit: 5 }] });
  sheet.columns = [
    { key: "code", width: 22 }, { key: "description", width: 42 }, { key: "quantity", width: 14 },
    { key: "date", width: 22 }, { key: "photo", width: 22 }
  ];
  sheet.addRow(["CONFERÊNCIA DE MERCADORIAS"]);
  sheet.mergeCells("A1:E1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF0F766E" } };
  sheet.addRow(["Nota", conference.invoice]);
  sheet.addRow(["Conferente", conference.inspector]);
  sheet.addRow(["Salva em", formatDate(conference.savedAt || conference.updatedAt)]);
  const header = sheet.addRow(["Código", "Descrição", "Quantidade", "Registrado em", "Foto"]);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };

  conference.items.forEach((item) => {
    const row = sheet.addRow([item.barcode, item.description, item.quantity, formatDate(item.updatedAt), ""]);
    row.height = 72;
    if (item.photo?.startsWith("data:image")) {
      try {
        const imageId = workbook.addImage({ base64: item.photo, extension: item.photo.includes("image/png") ? "png" : "jpeg" });
        sheet.addImage(imageId, { tl: { col: 4.08, row: row.number - 0.92 }, ext: { width: 120, height: 88 } });
      } catch (error) { row.getCell(5).value = "Foto não incorporada"; }
    }
  });
  sheet.eachRow((row) => row.eachCell((cell) => { cell.alignment = { vertical: "middle", wrapText: true }; }));
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(buffer, `${safeName(conference.invoice)}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

function exportPdf(conference) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return alert("Permita a abertura de janelas para gerar o PDF.");
  const rows = conference.items.map((item) => `
    <tr><td>${escapeHtml(item.barcode)}</td><td><strong>${escapeHtml(item.description)}</strong></td>
    <td>${item.quantity}</td><td>${item.photo ? `<img src="${item.photo}" alt="Foto">` : "Sem foto"}</td></tr>`).join("");
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(conference.invoice)}</title>
    <style>@page{size:A4;margin:12mm}body{font:12px Arial;color:#1f2933}h1{color:#0f766e;margin-bottom:8px}.meta{margin:3px 0}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:middle}th{background:#0f766e;color:white}img{width:110px;height:82px;object-fit:cover}.footer{margin-top:12px;color:#64748b}@media print{button{display:none}}</style></head><body>
    <h1>Conferência de mercadorias</h1><p class="meta"><b>Nota:</b> ${escapeHtml(conference.invoice)}</p>
    <p class="meta"><b>Conferente:</b> ${escapeHtml(conference.inspector)}</p><p class="meta"><b>Data:</b> ${formatDate(conference.savedAt || conference.updatedAt)}</p>
    <table><thead><tr><th>Código</th><th>Descrição</th><th>Qtd.</th><th>Foto</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="footer">${conference.items.length} itens · ${sumUnits(conference.items)} unidades</p>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script></body></html>`);
  printWindow.document.close();
}

function renderAll() {
  renderDraft();
  renderHistory();
  $("#totalConferences").textContent = conferences.length;
  $("#totalItems").textContent = conferences.reduce((sum, entry) => sum + entry.items.length, 0);
}

function renderDraft() {
  draftItems.innerHTML = "";
  draftEmpty.hidden = draft.items.length > 0;
  draft.items.forEach((item) => {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.querySelector("h3").textContent = item.description;
    node.querySelector(".qty-pill").textContent = `${item.quantity} un.`;
    node.querySelector(".code-line").textContent = `Código: ${item.barcode}`;
    if (item.photo) {
      const image = new Image(); image.src = item.photo; image.alt = item.description;
      node.querySelector(".thumb").append(image);
    }
    draftItems.append(node);
  });
  $("#draftCount").textContent = `${draft.items.length} ${draft.items.length === 1 ? "item" : "itens"}`;
  $("#draftUnits").textContent = `${sumUnits(draft.items)} unidades`;
  updateDraftTitle();
}

function renderHistory() {
  const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const filtered = conferences.filter((entry) => [entry.invoice, entry.inspector, ...entry.items.flatMap((item) => [item.barcode, item.description])]
    .some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query)));
  conferenceList.innerHTML = "";
  historyEmpty.hidden = filtered.length > 0;
  filtered.forEach((conference) => {
    const node = conferenceTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = conference.id;
    node.querySelector(".card-date").textContent = formatDate(conference.savedAt || conference.updatedAt);
    node.querySelector(".card-invoice").textContent = conference.invoice;
    node.querySelector(".card-inspector").textContent = `Conferente: ${conference.inspector}`;
    node.querySelector(".card-summary").textContent = `${conference.items.length} itens · ${sumUnits(conference.items)} unidades`;
    conferenceList.append(node);
  });
}

function syncDraftFields() {
  invoiceInput.value = draft.invoice || "";
  inspectorInput.value = draft.inspector || "";
  updateDraftTitle();
}

function updateDraftTitle() {
  $("#draftTitle").textContent = draft.id ? `Editando: ${draft.invoice}` : "Nova conferência";
}

function resetItemForm() {
  editingItemId = null;
  currentPhoto = "";
  form.reset();
  quantityInput.value = 1;
  form.querySelector(".primary-action").textContent = "Adicionar item";
  renderPhotoPreview();
}

function renderPhotoPreview() {
  photoPreview.innerHTML = currentPhoto ? `<img src="${currentPhoto}" alt="Foto da mercadoria">` : "<span>Sem foto</span>";
}

async function startScanner() {
  if (!window.isSecureContext || !window.Html5Qrcode) return openPhotoScanner();
  try {
    scanner = new Html5Qrcode("barcodeReader");
    barcodeReader.classList.add("active");
    scannerFallback.hidden = true;
    startScanButton.disabled = true;
    stopScanButton.disabled = false;
    setScanStatus("Aponte a câmera para o código.");
    await scanner.start({ facingMode: "environment" }, { fps: 8, qrbox: { width: 280, height: 150 } }, handleBarcode);
  } catch (error) {
    await stopScanner();
    openPhotoScanner();
  }
}

async function stopScanner() {
  if (scanner) {
    try { await scanner.stop(); } catch (error) { /* scanner ainda não iniciado */ }
    try { await scanner.clear(); } catch (error) { /* área já limpa */ }
    scanner = null;
  }
  barcodeReader.classList.remove("active");
  scannerFallback.hidden = false;
  startScanButton.disabled = false;
  stopScanButton.disabled = true;
}

function openPhotoScanner() {
  setScanStatus("Fotografe o código de barras de perto.");
  barcodePhotoInput.value = "";
  barcodePhotoInput.click();
}

async function scanCapturedPhoto() {
  const file = barcodePhotoInput.files?.[0];
  if (!file || !window.Html5Qrcode) return;
  const fileScanner = new Html5Qrcode("barcodeReader");
  try {
    setScanStatus("Lendo código...");
    handleBarcode(await fileScanner.scanFile(file, false));
  } catch (error) {
    setScanStatus("Não consegui ler. Tente outra foto ou digite o código.");
  } finally {
    try { await fileScanner.clear(); } catch (error) { /* nada para limpar */ }
  }
}

function handleBarcode(value) {
  const code = String(value || "").trim();
  if (!code) return;
  barcodeInput.value = code;
  stopScanner();
  setScanStatus(`Código lido: ${code}`);
  descriptionInput.focus();
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const max = 760;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.68));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function persistDraft() { return writeJson(draftKey, draft, "#formStatus"); }
function blankDraft() { return { id: null, invoice: "", inspector: "", items: [], startedAt: new Date().toISOString() }; }
function sumUnits(items) { return items.reduce((sum, item) => sum + Number(item.quantity || 0), 0); }
function makeId() { return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formatDate(value) { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function safeName(value) { return String(value).replace(/[\\/:*?"<>|]+/g, "-").trim() || "conferencia"; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (error) { return fallback; } }
function writeJson(key, value, statusSelector) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { showMessage(statusSelector || "#conferenceStatus", "Memória cheia. Exporte ou exclua conferências antigas."); return false; }
}
function downloadBlob(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showMessage(selector, text, focusTarget) {
  const element = $(selector); element.textContent = text;
  if (focusTarget) { focusTarget.focus(); focusTarget.scrollIntoView({ behavior: "smooth", block: "center" }); }
  clearTimeout(messageTimer); messageTimer = setTimeout(() => { element.textContent = ""; }, 5000);
  return false;
}
function setScanStatus(text) { $("#scanStatus").textContent = text; }
function migrateOldItems() {
  if (draft.items.length || conferences.length) return;
  const oldItems = readJson("conferencia-mercadorias-v1", []);
  if (oldItems.length) { draft.items = oldItems; persistDraft(); }
}
