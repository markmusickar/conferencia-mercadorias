const keys = {
  conferences: "conferencia-mercadorias-v3",
  draft: "conferencia-rascunho-v3",
  orders: "pedidos-compra-v1",
  orderDraft: "pedido-compra-rascunho-v1",
  session: "conferencia-sessao-v1"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const blankConference = () => ({ id: null, invoice: "", inspector: "", items: [], startedAt: new Date().toISOString() });
const blankOrder = () => ({ id: null, number: "", buyer: "", items: [], startedAt: new Date().toISOString() });

let conferences = readJson(keys.conferences, readJson("conferencia-mercadorias-v2", []));
let orders = readJson(keys.orders, []);
let draft = readJson(keys.draft, readJson("conferencia-rascunho-v2", blankConference()));
let orderDraft = readJson(keys.orderDraft, blankOrder());
let session = readJson(keys.session, { role: "admin" });
let editingItemId = null;
let editingOrderItemId = null;
let currentPhoto = "";
let scanner = null;
let messageTimer = null;
let lastComparison = null;

bindEvents();
syncSession();
syncDraftFields();
syncOrderFields();
renderAll();

function bindEvents() {
  $$(".tab-button").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $$(".role-button").forEach((button) => button.addEventListener("click", () => setRole(button.dataset.role)));

  $("#goToNew").addEventListener("click", () => showView("new"));
  $("#newConference").addEventListener("click", startNewConference);
  $("#clearForm").addEventListener("click", resetItemForm);
  $("#saveConference").addEventListener("click", saveConference);
  $("#invoiceNumber").addEventListener("input", saveDraftHeader);
  $("#inspectorName").addEventListener("input", saveDraftHeader);
  $("#photo").addEventListener("change", loadItemPhoto);
  $("#itemForm").addEventListener("submit", addOrUpdateItem);
  $("#draftItems").addEventListener("click", handleDraftItemAction);
  $("#conferenceList").addEventListener("click", handleConferenceAction);
  $("#conferenceSearch").addEventListener("input", renderHistory);
  $("#startScan").addEventListener("click", startScanner);
  $("#stopScan").addEventListener("click", stopScanner);
  $("#barcodePhoto").addEventListener("change", scanCapturedPhoto);

  $("#newOrder").addEventListener("click", startNewOrder);
  $("#orderForm").addEventListener("submit", addOrUpdateOrderItem);
  $("#clearOrderItem").addEventListener("click", resetOrderItemForm);
  $("#saveOrder").addEventListener("click", saveOrder);
  $("#orderNumber").addEventListener("input", saveOrderHeader);
  $("#buyerName").addEventListener("input", saveOrderHeader);
  $("#orderItems").addEventListener("click", handleOrderItemAction);
  $("#ordersList").addEventListener("click", handleOrderAction);
  $("#orderSearch").addEventListener("input", renderOrders);

  $("#runCompare").addEventListener("click", runComparison);
  $("#exportComparePdf").addEventListener("click", exportComparisonPdf);
}

function setRole(role) {
  session.role = role;
  writeJson(keys.session, session);
  syncSession();
}

function syncSession() {
  const labels = { conferente: "Conferente", compras: "Compras", admin: "Administrador" };
  $$(".role-button").forEach((button) => button.classList.toggle("active", button.dataset.role === session.role));
  $("#sessionTitle").textContent = `Perfil atual: ${labels[session.role] || "Administrador"}`;

  const allowed = {
    conferente: ["new", "history"],
    compras: ["orders"],
    admin: ["new", "history", "orders", "compare"]
  }[session.role] || ["new", "history", "orders", "compare"];

  $$(".tab-button").forEach((button) => { button.hidden = !allowed.includes(button.dataset.view); });
  const active = $(".tab-button.active");
  if (!active || active.hidden) showView(allowed[0]);
}

function showView(name) {
  const targetButton = $(`.tab-button[data-view="${name}"]`);
  if (targetButton?.hidden) return;
  $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => view.classList.remove("active"));
  $(`#${name}View`)?.classList.add("active");
  if (name === "history") renderHistory();
  if (name === "orders") renderOrders();
  if (name === "compare") renderCompareOptions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function saveDraftHeader() {
  draft.invoice = $("#invoiceNumber").value.trim();
  draft.inspector = $("#inspectorName").value.trim();
  persistDraft();
  updateDraftTitle();
}

async function loadItemPhoto() {
  const file = $("#photo").files?.[0];
  currentPhoto = file ? await resizeImage(file) : "";
  renderPhotoPreview();
}

function addOrUpdateItem(event) {
  event.preventDefault();
  const item = collectItem({
    barcode: $("#barcode").value,
    description: $("#description").value,
    quantity: $("#quantity").value,
    photo: currentPhoto
  }, "#formStatus", true);
  if (!item) return;

  const now = new Date().toISOString();
  if (editingItemId) {
    draft.items = draft.items.map((entry) => entry.id === editingItemId ? { ...entry, ...item, updatedAt: now } : entry);
  } else {
    draft.items.unshift({ id: makeId(), ...item, createdAt: now, updatedAt: now });
  }

  if (!persistDraft()) return;
  showMessage("#formStatus", editingItemId ? "Item atualizado." : "Item adicionado. Pode registrar o próximo.");
  resetItemForm();
  renderDraft();
}

function collectItem(raw, statusSelector, requirePhoto) {
  const barcode = String(raw.barcode || "").trim();
  const description = String(raw.description || "").trim();
  const quantity = Number(raw.quantity);
  const photo = raw.photo || "";
  if (!barcode) return showMessage(statusSelector, "Informe ou leia o código de barras.");
  if (!description) return showMessage(statusSelector, "Informe a descrição da mercadoria.");
  if (!Number.isFinite(quantity) || quantity < 1) return showMessage(statusSelector, "Informe uma quantidade válida.");
  if (requirePhoto && !photo) return showMessage(statusSelector, "Tire uma foto da mercadoria.");
  return { barcode, description, quantity, photo };
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
    $("#barcode").value = item.barcode;
    $("#description").value = item.description;
    $("#quantity").value = item.quantity;
    currentPhoto = item.photo;
    renderPhotoPreview();
    $("#itemForm .primary-action").textContent = "Salvar alteração";
    $("#barcode").focus();
  }
}

function saveConference() {
  saveDraftHeader();
  if (!draft.invoice) return showMessage("#conferenceStatus", "Informe o nome ou número da nota.", $("#invoiceNumber"));
  if (!draft.inspector) return showMessage("#conferenceStatus", "Informe o nome do conferente.", $("#inspectorName"));
  if (!draft.items.length) return showMessage("#conferenceStatus", "Adicione pelo menos um item à conferência.");

  const now = new Date().toISOString();
  const record = { ...draft, id: draft.id || makeId(), savedAt: draft.savedAt || now, updatedAt: now };
  const existingIndex = conferences.findIndex((entry) => entry.id === record.id);
  if (existingIndex >= 0) conferences[existingIndex] = record;
  else conferences.unshift(record);
  if (!writeJson(keys.conferences, conferences, "#conferenceStatus")) return;

  localStorage.removeItem(keys.draft);
  draft = blankConference();
  syncDraftFields();
  resetItemForm();
  renderAll();
  showView("history");
}

function startNewConference() {
  const hasContent = draft.invoice || draft.inspector || draft.items.length;
  if (hasContent && !confirm("Limpar a conferência atual e iniciar outra?")) return;
  draft = blankConference();
  localStorage.removeItem(keys.draft);
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
  writeJson(keys.conferences, conferences);
  renderAll();
}

function saveOrderHeader() {
  orderDraft.number = $("#orderNumber").value.trim();
  orderDraft.buyer = $("#buyerName").value.trim();
  persistOrderDraft();
  updateOrderTitle();
}

function addOrUpdateOrderItem(event) {
  event.preventDefault();
  const item = collectItem({
    barcode: $("#orderBarcode").value,
    description: $("#orderDescription").value,
    quantity: $("#orderQuantity").value
  }, "#orderStatus", false);
  if (!item) return;

  const now = new Date().toISOString();
  delete item.photo;
  if (editingOrderItemId) {
    orderDraft.items = orderDraft.items.map((entry) => entry.id === editingOrderItemId ? { ...entry, ...item, updatedAt: now } : entry);
  } else {
    orderDraft.items.unshift({ id: makeId(), ...item, createdAt: now, updatedAt: now });
  }
  if (!persistOrderDraft()) return;
  showMessage("#orderStatus", editingOrderItemId ? "Item do pedido atualizado." : "Item adicionado ao pedido.");
  resetOrderItemForm();
  renderOrderDraft();
}

function handleOrderItemAction(event) {
  const button = event.target.closest("button");
  const card = event.target.closest(".item-card");
  if (!button || !card) return;
  const item = orderDraft.items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;

  if (button.classList.contains("remove")) {
    if (!confirm(`Excluir ${item.description} do pedido?`)) return;
    orderDraft.items = orderDraft.items.filter((entry) => entry.id !== item.id);
    persistOrderDraft();
    renderOrderDraft();
  }
  if (button.classList.contains("edit")) {
    editingOrderItemId = item.id;
    $("#orderBarcode").value = item.barcode;
    $("#orderDescription").value = item.description;
    $("#orderQuantity").value = item.quantity;
    $("#orderForm .primary-action").textContent = "Salvar alteração";
    $("#orderBarcode").focus();
  }
}

function saveOrder() {
  saveOrderHeader();
  if (!orderDraft.number) return showMessage("#saveOrderStatus", "Informe o número ou nome do pedido.", $("#orderNumber"));
  if (!orderDraft.buyer) return showMessage("#saveOrderStatus", "Informe o responsável por compras.", $("#buyerName"));
  if (!orderDraft.items.length) return showMessage("#saveOrderStatus", "Adicione pelo menos um item ao pedido.");

  const now = new Date().toISOString();
  const record = { ...orderDraft, id: orderDraft.id || makeId(), savedAt: orderDraft.savedAt || now, updatedAt: now };
  const existingIndex = orders.findIndex((entry) => entry.id === record.id);
  if (existingIndex >= 0) orders[existingIndex] = record;
  else orders.unshift(record);
  if (!writeJson(keys.orders, orders, "#saveOrderStatus")) return;

  localStorage.removeItem(keys.orderDraft);
  orderDraft = blankOrder();
  syncOrderFields();
  resetOrderItemForm();
  renderAll();
  showMessage("#saveOrderStatus", "Pedido salvo.");
}

function startNewOrder() {
  const hasContent = orderDraft.number || orderDraft.buyer || orderDraft.items.length;
  if (hasContent && !confirm("Limpar o pedido atual e iniciar outro?")) return;
  orderDraft = blankOrder();
  localStorage.removeItem(keys.orderDraft);
  syncOrderFields();
  resetOrderItemForm();
  renderOrderDraft();
}

function handleOrderAction(event) {
  const button = event.target.closest("button");
  const card = event.target.closest(".conference-card");
  if (!button || !card) return;
  const order = orders.find((entry) => entry.id === card.dataset.id);
  if (!order) return;
  if (button.classList.contains("open-conference")) openOrder(order);
  if (button.classList.contains("export-excel")) exportOrderExcel(order);
  if (button.classList.contains("export-pdf")) exportOrderPdf(order);
  if (button.classList.contains("delete-conference")) deleteOrder(order);
}

function openOrder(order) {
  const hasOtherDraft = (orderDraft.number || orderDraft.buyer || orderDraft.items.length) && orderDraft.id !== order.id;
  if (hasOtherDraft && !confirm("Substituir o pedido em edição por este?")) return;
  orderDraft = JSON.parse(JSON.stringify(order));
  persistOrderDraft();
  syncOrderFields();
  renderOrderDraft();
  showView("orders");
}

function deleteOrder(order) {
  if (!confirm(`Excluir definitivamente o pedido ${order.number}?`)) return;
  orders = orders.filter((entry) => entry.id !== order.id);
  writeJson(keys.orders, orders);
  renderAll();
}

async function exportExcel(conference) {
  if (!window.ExcelJS) return alert("O recurso de Excel não carregou. Verifique a internet e tente novamente.");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Conferência", { views: [{ state: "frozen", ySplit: 5 }] });
  sheet.columns = [{ key: "code", width: 22 }, { key: "description", width: 42 }, { key: "quantity", width: 14 }, { key: "date", width: 22 }, { key: "photo", width: 22 }];
  sheet.addRow(["CONFERÊNCIA DE MERCADORIAS"]);
  sheet.mergeCells("A1:E1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF0F766E" } };
  sheet.addRow(["Nota", conference.invoice]);
  sheet.addRow(["Conferente", conference.inspector]);
  sheet.addRow(["Salva em", formatDate(conference.savedAt || conference.updatedAt)]);
  const header = sheet.addRow(["Código", "Descrição", "Quantidade", "Registrado em", "Foto"]);
  styleHeader(header);
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

async function exportOrderExcel(order) {
  if (!window.ExcelJS) return alert("O recurso de Excel não carregou. Verifique a internet e tente novamente.");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Pedido de compra");
  sheet.columns = [{ key: "code", width: 22 }, { key: "description", width: 42 }, { key: "quantity", width: 16 }];
  sheet.addRow(["PEDIDO DE COMPRA"]);
  sheet.mergeCells("A1:C1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF0F766E" } };
  sheet.addRow(["Pedido", order.number]);
  sheet.addRow(["Compras", order.buyer]);
  const header = sheet.addRow(["Código", "Descrição", "Quantidade pedida"]);
  styleHeader(header);
  order.items.forEach((item) => sheet.addRow([item.barcode, item.description, item.quantity]));
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(buffer, `${safeName(order.number)}-pedido.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

function exportPdf(conference) {
  printReport({
    title: "Conferência de mercadorias",
    meta: [["Nota", conference.invoice], ["Conferente", conference.inspector], ["Data", formatDate(conference.savedAt || conference.updatedAt)]],
    headers: ["Código", "Descrição", "Qtd.", "Foto"],
    rows: conference.items.map((item) => [item.barcode, `<strong>${escapeHtml(item.description)}</strong>`, item.quantity, item.photo ? `<img src="${item.photo}" alt="Foto">` : "Sem foto"]),
    footer: `${conference.items.length} itens · ${sumUnits(conference.items)} unidades`
  });
}

function exportOrderPdf(order) {
  printReport({
    title: "Pedido de compra",
    meta: [["Pedido", order.number], ["Compras", order.buyer], ["Data", formatDate(order.savedAt || order.updatedAt)]],
    headers: ["Código", "Descrição", "Quantidade pedida"],
    rows: order.items.map((item) => [item.barcode, `<strong>${escapeHtml(item.description)}</strong>`, item.quantity]),
    footer: `${order.items.length} itens · ${sumUnits(order.items)} unidades`
  });
}

function runComparison() {
  const order = orders.find((entry) => entry.id === $("#compareOrder").value);
  const conference = conferences.find((entry) => entry.id === $("#compareConference").value);
  if (!order || !conference) return showMessage("#compareResult", "Escolha um pedido e uma conferência para comparar.");
  lastComparison = buildComparison(order, conference);
  renderComparison(lastComparison);
}

function buildComparison(order, conference) {
  const map = new Map();
  order.items.forEach((item) => {
    const current = map.get(item.barcode) || { barcode: item.barcode, description: item.description, ordered: 0, received: 0, photos: [] };
    current.ordered += Number(item.quantity || 0);
    map.set(item.barcode, current);
  });
  conference.items.forEach((item) => {
    const current = map.get(item.barcode) || { barcode: item.barcode, description: item.description, ordered: 0, received: 0, photos: [] };
    current.received += Number(item.quantity || 0);
    if (item.photo) current.photos.push(item.photo);
    map.set(item.barcode, current);
  });
  const rows = [...map.values()].map((row) => ({ ...row, diff: row.received - row.ordered, status: statusFor(row) }));
  return { order, conference, rows };
}

function statusFor(row) {
  if (row.ordered === row.received) return "OK";
  if (row.ordered === 0) return "Sobra";
  if (row.received === 0) return "Falta";
  return row.received > row.ordered ? "Sobra parcial" : "Falta parcial";
}

function renderComparison(comparison) {
  $("#compareEmpty").hidden = true;
  $("#compareResult").innerHTML = `
    <div class="compare-summary">
      <span><strong>${comparison.order.number}</strong> pedido</span>
      <span><strong>${comparison.conference.invoice}</strong> conferência</span>
      <span><strong>${comparison.rows.filter((row) => row.status !== "OK").length}</strong> divergências</span>
    </div>
    <div class="table-wrap">
      <table class="compare-table">
        <thead><tr><th>Código</th><th>Descrição</th><th>Pedido</th><th>Recebido</th><th>Dif.</th><th>Status</th></tr></thead>
        <tbody>${comparison.rows.map((row) => `<tr class="${row.status === "OK" ? "ok" : "warn"}"><td>${escapeHtml(row.barcode)}</td><td>${escapeHtml(row.description)}</td><td>${row.ordered}</td><td>${row.received}</td><td>${row.diff}</td><td>${row.status}</td></tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function exportComparisonPdf() {
  if (!lastComparison) runComparison();
  if (!lastComparison) return;
  printReport({
    title: "Comparação pedido x conferência",
    meta: [["Pedido", lastComparison.order.number], ["Conferência", lastComparison.conference.invoice], ["Gerado em", formatDate(new Date().toISOString())]],
    headers: ["Código", "Descrição", "Pedido", "Recebido", "Dif.", "Status"],
    rows: lastComparison.rows.map((row) => [row.barcode, `<strong>${escapeHtml(row.description)}</strong>`, row.ordered, row.received, row.diff, row.status]),
    footer: `${lastComparison.rows.filter((row) => row.status !== "OK").length} divergências`
  });
}

function printReport({ title, meta, headers, rows, footer }) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return alert("Permita a abertura de janelas para gerar o PDF.");
  const metaHtml = meta.map(([label, value]) => `<p class="meta"><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</p>`).join("");
  const headHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowsHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${typeof cell === "number" ? cell : String(cell)}</td>`).join("")}</tr>`).join("");
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>@page{size:A4;margin:12mm}body{font:12px Arial;color:#1f2933}h1{color:#0f766e;margin-bottom:8px}.meta{margin:3px 0}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:middle}th{background:#0f766e;color:white}img{width:110px;height:82px;object-fit:cover}.footer{margin-top:12px;color:#64748b}@media print{button{display:none}}</style></head><body>
    <h1>${escapeHtml(title)}</h1>${metaHtml}
    <table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>
    <p class="footer">${escapeHtml(footer)}</p>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script></body></html>`);
  printWindow.document.close();
}

function renderAll() {
  renderDraft();
  renderHistory();
  renderOrderDraft();
  renderOrders();
  renderCompareOptions();
  $("#totalConferences").textContent = conferences.length;
  $("#totalOrders").textContent = orders.length;
  $("#totalItems").textContent = conferences.reduce((sum, entry) => sum + entry.items.length, 0);
}

function renderDraft() {
  renderItemList("#draftItems", draft.items, true);
  $("#draftEmpty").hidden = draft.items.length > 0;
  $("#draftCount").textContent = `${draft.items.length} ${draft.items.length === 1 ? "item" : "itens"}`;
  $("#draftUnits").textContent = `${sumUnits(draft.items)} unidades`;
  updateDraftTitle();
}

function renderOrderDraft() {
  renderItemList("#orderItems", orderDraft.items, false);
  $("#orderItemsEmpty").hidden = orderDraft.items.length > 0;
  $("#orderUnits").textContent = `${sumUnits(orderDraft.items)} unidades`;
  updateOrderTitle();
}

function renderItemList(selector, items, showPhoto) {
  const container = $(selector);
  container.innerHTML = "";
  items.forEach((item) => {
    const node = $("#itemTemplate").content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.querySelector("h3").textContent = item.description;
    node.querySelector(".qty-pill").textContent = `${item.quantity} un.`;
    node.querySelector(".code-line").textContent = `Código: ${item.barcode}`;
    if (showPhoto && item.photo) {
      const image = new Image();
      image.src = item.photo;
      image.alt = item.description;
      node.querySelector(".thumb").append(image);
    } else {
      node.querySelector(".thumb").innerHTML = `<span>${showPhoto ? "Sem foto" : "Pedido"}</span>`;
    }
    container.append(node);
  });
}

function renderHistory() {
  const query = $("#conferenceSearch").value.trim().toLocaleLowerCase("pt-BR");
  const filtered = conferences.filter((entry) => [entry.invoice, entry.inspector, ...entry.items.flatMap((item) => [item.barcode, item.description])]
    .some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query)));
  renderCards("#conferenceList", "#historyEmpty", filtered, "conference");
}

function renderOrders() {
  const query = $("#orderSearch").value.trim().toLocaleLowerCase("pt-BR");
  const filtered = orders.filter((entry) => [entry.number, entry.buyer, ...entry.items.flatMap((item) => [item.barcode, item.description])]
    .some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query)));
  renderCards("#ordersList", "#ordersEmpty", filtered, "order");
}

function renderCards(listSelector, emptySelector, records, type) {
  const list = $(listSelector);
  list.innerHTML = "";
  $(emptySelector).hidden = records.length > 0;
  records.forEach((record) => {
    const node = $("#conferenceTemplate").content.firstElementChild.cloneNode(true);
    node.dataset.id = record.id;
    const isOrder = type === "order";
    node.querySelector(".card-date").textContent = formatDate(record.savedAt || record.updatedAt);
    node.querySelector(".card-invoice").textContent = isOrder ? record.number : record.invoice;
    node.querySelector(".card-inspector").textContent = isOrder ? `Compras: ${record.buyer}` : `Conferente: ${record.inspector}`;
    node.querySelector(".card-summary").textContent = `${record.items.length} itens · ${sumUnits(record.items)} unidades`;
    node.querySelector(".export-pdf").textContent = isOrder ? "PDF" : "PDF com fotos";
    list.append(node);
  });
}

function renderCompareOptions() {
  fillSelect("#compareOrder", orders, (order) => `${order.number} — ${sumUnits(order.items)} un.`);
  fillSelect("#compareConference", conferences, (conference) => `${conference.invoice} — ${sumUnits(conference.items)} un.`);
  if (!orders.length || !conferences.length) {
    $("#compareEmpty").hidden = false;
    $("#compareResult").innerHTML = "";
    lastComparison = null;
  }
}

function fillSelect(selector, records, labeler) {
  const select = $(selector);
  const previous = select.value;
  select.innerHTML = records.length ? records.map((record) => `<option value="${record.id}">${escapeHtml(labeler(record))}</option>`).join("") : `<option value="">Nada salvo ainda</option>`;
  if (records.some((record) => record.id === previous)) select.value = previous;
}

function syncDraftFields() {
  $("#invoiceNumber").value = draft.invoice || "";
  $("#inspectorName").value = draft.inspector || "";
  updateDraftTitle();
}

function syncOrderFields() {
  $("#orderNumber").value = orderDraft.number || "";
  $("#buyerName").value = orderDraft.buyer || "";
  updateOrderTitle();
}

function updateDraftTitle() { $("#draftTitle").textContent = draft.id ? `Editando: ${draft.invoice}` : "Nova conferência"; }
function updateOrderTitle() { $("#orderTitle").textContent = orderDraft.id ? `Editando: ${orderDraft.number}` : "Novo pedido de compra"; }

function resetItemForm() {
  editingItemId = null;
  currentPhoto = "";
  $("#itemForm").reset();
  $("#quantity").value = 1;
  $("#itemForm .primary-action").textContent = "Adicionar item";
  renderPhotoPreview();
}

function resetOrderItemForm() {
  editingOrderItemId = null;
  $("#orderBarcode").value = "";
  $("#orderDescription").value = "";
  $("#orderQuantity").value = 1;
  $("#orderForm .primary-action").textContent = "Adicionar item";
}

function renderPhotoPreview() {
  $("#photoPreview").innerHTML = currentPhoto ? `<img src="${currentPhoto}" alt="Foto da mercadoria">` : "<span>Sem foto</span>";
}

async function startScanner() {
  if (!window.isSecureContext || !window.Html5Qrcode) return openPhotoScanner();
  try {
    scanner = new Html5Qrcode("barcodeReader");
    $("#barcodeReader").classList.add("active");
    $("#scannerFallback").hidden = true;
    $("#startScan").disabled = true;
    $("#stopScan").disabled = false;
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
  $("#barcodeReader").classList.remove("active");
  $("#scannerFallback").hidden = false;
  $("#startScan").disabled = false;
  $("#stopScan").disabled = true;
}

function openPhotoScanner() {
  setScanStatus("Fotografe o código de barras de perto.");
  $("#barcodePhoto").value = "";
  $("#barcodePhoto").click();
}

async function scanCapturedPhoto() {
  const file = $("#barcodePhoto").files?.[0];
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
  $("#barcode").value = code;
  stopScanner();
  setScanStatus(`Código lido: ${code}`);
  $("#description").focus();
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

function persistDraft() { return writeJson(keys.draft, draft, "#formStatus"); }
function persistOrderDraft() { return writeJson(keys.orderDraft, orderDraft, "#orderStatus"); }
function sumUnits(items) { return items.reduce((sum, item) => sum + Number(item.quantity || 0), 0); }
function makeId() { return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formatDate(value) { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function safeName(value) { return String(value).replace(/[\\/:*?"<>|]+/g, "-").trim() || "arquivo"; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (error) { return fallback; } }
function writeJson(key, value, statusSelector) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { showMessage(statusSelector || "#conferenceStatus", "Memória cheia. Exporte ou exclua registros antigos."); return false; }
}
function downloadBlob(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showMessage(selector, text, focusTarget) {
  const element = $(selector);
  element.textContent = text;
  if (focusTarget) { focusTarget.focus(); focusTarget.scrollIntoView({ behavior: "smooth", block: "center" }); }
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { element.textContent = ""; }, 5000);
  return false;
}
function setScanStatus(text) { $("#scanStatus").textContent = text; }
function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
}
