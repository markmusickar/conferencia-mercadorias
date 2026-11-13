const supabaseUrl = "https://upozyqpdmxhhnynqoefs.supabase.co";
const supabaseKey = "sb_publishable_CyoDQRGvNzohmPjijToDAQ_9zYdIcIy";
const defaultLoginDomain = "lojaosuper20cupira.com.br";
const supabaseClient = window.supabase?.createClient(supabaseUrl, supabaseKey);

const keys = {
  draft: "conferencia-rascunho-online-v1",
  orderDraft: "pedido-compra-rascunho-online-v1"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const blankConference = () => ({ id: null, invoice: "", inspector: "", items: [], startedAt: new Date().toISOString() });
const blankOrder = () => ({ id: null, number: "", buyer: "", items: [], startedAt: new Date().toISOString() });

let currentUser = null;
let currentProfile = null;
let conferences = [];
let losses = [];
let recordMode = "conference";
const conferenceDraftKey = keys.draft;
const lossDraftKey = "perdas-rascunho-online-v1";
let orders = [];
let draft = readJson(keys.draft, blankConference());
let orderDraft = readJson(keys.orderDraft, blankOrder());
let editingItemId = null;
let editingOrderItemId = null;
let currentPhoto = "";
let scanner = null;
let scannerMode = "conference";
let messageTimer = null;
let lastComparison = null;
const productLookups = new Map();
// Códigos extras: vários códigos de barras do mesmo produto (comum em importados).
let codeToProduct = new Map();
let codesByProduct = new Map();
function addCodeLink(code, main) {
  codeToProduct.set(code, main);
  const list = codesByProduct.get(main) || [];
  if (!list.includes(code)) list.push(code);
  codesByProduct.set(main, list);
}
function removeCodeLink(code) {
  const main = codeToProduct.get(code);
  codeToProduct.delete(code);
  if (main) codesByProduct.set(main, (codesByProduct.get(main) || []).filter((entry) => entry !== code));
}
function canonicalCode(code) {
  const clean = String(code || "").trim();
  return codeToProduct.get(clean) || clean;
}
function allCodes(main) { return [main, ...(codesByProduct.get(main) || [])]; }
function codesText(main) { return allCodes(main).map(displayBarcode).join(" / "); }
function codesHtml(main) { return allCodes(main).map((code) => escapeHtml(displayBarcode(code))).join("<br>"); }
// Grava no banco os vínculos feitos com produtos que ainda não estavam salvos (o produto passa a existir ao salvar a conferência).
async function flushPendingLinks() {
  for (const link of draft.pendingLinks || []) {
    try { await supabaseClient.rpc("link_product_code", { p_code: link.code, p_product_barcode: link.main }); } catch (_) { /* tenta de novo pelo botão de vincular */ }
  }
  await loadProductCodes();
}
async function loadProductCodes() {
  codeToProduct = new Map();
  codesByProduct = new Map();
  if (!currentUser) return;
  try {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabaseClient.from("product_codes").select("code, product_barcode").order("code").range(offset, offset + 999);
      if (error) return;  // sem a tabela (SQL ainda não executado), o sistema funciona como antes
      for (const row of data || []) addCodeLink(row.code, row.product_barcode);
      if (!data || data.length < 1000) break;
    }
  } catch (_) { /* segue sem os códigos extras */ }
  for (const link of (typeof draft === "object" && draft?.pendingLinks) || []) addCodeLink(link.code, link.main);
}

// A stable internal reference keeps products without barcodes distinct in storage and totals.
const NO_BARCODE_PREFIX = "SEM-CODIGO:";
function isWithoutBarcode(code) { return String(code || "").startsWith(NO_BARCODE_PREFIX); }
function displayBarcode(code) { return isWithoutBarcode(code) ? "Sem código de barras" : code; }
function syncNoBarcode(order = false, focus = false) {
  const inputSelector = order ? "#orderBarcode" : "#barcode";
  const input = $(inputSelector);
  const checked = $(order ? "#orderNoBarcode" : "#noBarcode").checked;
  input.disabled = checked;
  input.required = !checked;
  if (checked) {
    input.value = "";
    productLookups.set(inputSelector, {});
    if (focus) $(order ? "#orderDescription" : "#description").focus();
  }
}

function bindProductLookup(inputSelector, descriptionSelector, statusSelector) {
  let timer;
  $(inputSelector).addEventListener("keydown", async event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    clearTimeout(timer);
    $(descriptionSelector).focus();
    const found = await fillProductDescription(inputSelector, descriptionSelector, statusSelector);
    if (found && document.activeElement === $(descriptionSelector)) {
      $(inputSelector === "#orderBarcode" ? "#orderQuantity" : "#quantity").focus();
    }
  });
  $(inputSelector).addEventListener("input", () => {
    clearTimeout(timer);
    const description = $(descriptionSelector);
    if (description.dataset.productDescription === description.value) description.value = "";
    delete description.dataset.productDescription;
    productLookups.set(inputSelector, {});
    timer = setTimeout(() => fillProductDescription(inputSelector, descriptionSelector, statusSelector), 300);
  });
  $(inputSelector).addEventListener("change", () => {
    clearTimeout(timer);
    fillProductDescription(inputSelector, descriptionSelector, statusSelector);
  });
}

async function fillProductDescription(inputSelector, descriptionSelector, statusSelector) {
  let code = $(inputSelector).value.trim();
  const descriptionInput = $(descriptionSelector);
  const originalDescription = descriptionInput.value;
  const request = {};
  productLookups.set(inputSelector, request);
  if (!code || !currentUser) return false;
  // Código extra de um produto: passa a valer o código principal, para a quantidade somar no mesmo item.
  let aliasNote = "";
  const mainCode = canonicalCode(code);
  if (mainCode !== code) {
    aliasNote = `Esse é outro código do mesmo produto (principal: ${displayBarcode(mainCode)}). `;
    $(inputSelector).value = mainCode;
    code = mainCode;
  }
  const lookupUserId = currentUser.id;
  let product;
  try {
    const { data, error } = await supabaseClient.from("products").select("description").eq("barcode", code).maybeSingle();
    if (!error) product = data;
  } catch (_) { /* Histórico disponível continua sendo uma alternativa. */ }
  if (currentUser?.id !== lookupUserId || productLookups.get(inputSelector) !== request || $(inputSelector).value.trim() !== code || descriptionInput.value !== originalDescription) return false;
  if (!product) {
    const matches = [...draft.items, ...conferences.flatMap(record => record.items)]
      .filter(item => item.barcode.trim() === code && item.description.trim());
    const descriptions = new Set(matches.map(item => item.description.trim().toLocaleLowerCase("pt-BR")));
    if (descriptions.size === 1) product = matches[0];
    if (descriptions.size > 1) {
      showMessage(statusSelector, "Este código tem descrições diferentes no histórico. Confirme a descrição.");
      return false;
    }
  }
  if (product && !originalDescription.trim()) {
    descriptionInput.value = product.description;
    descriptionInput.dataset.productDescription = product.description;
    showMessage(statusSelector, aliasNote + "Produto encontrado. Confira a descrição e informe a quantidade.");
    return true;
  }
  if (!product) showMessage(statusSelector, "Produto não cadastrado. Informe a descrição; ela será guardada ao salvar a conferência.");
  return false;
}

let catalogProducts = [];
let catalogPage = 0;
let catalogRequest = 0;
const catalogPageSize = 50;

async function loadProductCatalog() {
  if (currentProfile?.role !== "admin") return;
  const request = ++catalogRequest;
  const userId = currentUser?.id;
  catalogProducts = [];
  catalogPage = 0;
  renderProductCatalog();
  $("#productCatalogStatus").textContent = "Carregando produtos...";
  try {
    const loaded = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabaseClient.from("products")
        .select("barcode, description, updated_at").order("barcode").range(offset, offset + 499);
      if (request !== catalogRequest || currentUser?.id !== userId || currentProfile?.role !== "admin") return;
      if (error) throw error;
      loaded.push(...(data || []));
      if (!data || data.length < 500) break;
    }
    const photos = new Map();
    let photoWarning = false;
    try {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabaseClient.from("conference_items")
          .select("barcode, photo_url, created_at, id").neq("photo_url", "")
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 499);
        if (request !== catalogRequest || currentUser?.id !== userId || currentProfile?.role !== "admin") return;
        if (error) throw error;
        for (const item of data || []) {
          const code = item.barcode.trim();
          if (!photos.has(code) && validProductPhoto(item.photo_url)) photos.set(code, item.photo_url);
        }
        if (!data || data.length < 500) break;
      }
    } catch (_) { photoWarning = true; }
    if (request !== catalogRequest || currentUser?.id !== userId || currentProfile?.role !== "admin") return;
    catalogProducts = loaded.map(product => ({ ...product, photo_url: photos.get(product.barcode) || "" }));
    $("#productCatalogStatus").textContent = photoWarning ? "Os produtos foram carregados, mas algumas fotos podem estar indisponíveis. Toque em Atualizar para tentar novamente." : "";
    renderProductCatalog();
  } catch (_) {
    if (request !== catalogRequest || currentUser?.id !== userId || currentProfile?.role !== "admin") return;
    $("#productCatalogStatus").textContent = "Não foi possível carregar os produtos. Toque em Atualizar para tentar novamente.";
  }
}

let linkTimer = null;
function searchLinkTarget() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(async () => {
    const results = $("#linkResults");
    const query = $("#linkSearch").value.trim().replace(/[,()%*\\]/g, " ");
    results.innerHTML = "";
    if (query.length < 2 || !currentUser) return;
    const { data, error } = await supabaseClient.from("products").select("barcode, description")
      .or(`barcode.ilike.%${query}%,description.ilike.%${query}%`).order("description").limit(8);
    if (error) { $("#linkStatus").textContent = "Não foi possível procurar agora. Tente de novo."; return; }
    // Itens da conferência atual que ainda não foram salvos também podem ser o produto principal.
    const lower = query.toLocaleLowerCase("pt-BR");
    const found = new Set((data || []).map((product) => product.barcode));
    const fromDraft = (draft.items || []).filter((item) => item.barcode && !found.has(canonicalCode(item.barcode)) &&
      (item.barcode.toLocaleLowerCase("pt-BR").includes(lower) || String(item.description || "").toLocaleLowerCase("pt-BR").includes(lower)))
      .map((item) => ({ barcode: canonicalCode(item.barcode), description: item.description, fromDraft: true }));
    const list = [...(data || []), ...fromDraft].slice(0, 10);
    if (!list.length) { $("#linkStatus").textContent = "Nenhum produto encontrado com esse nome ou código."; return; }
    $("#linkStatus").textContent = "";
    for (const product of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-result";
      button.textContent = `${product.description} (${displayBarcode(product.barcode)})`;
      button.addEventListener("click", () => linkCurrentCode(product.barcode, product.fromDraft));
      results.append(button);
    }
  }, 300);
}

async function linkCurrentCode(mainCode, fromDraft = false) {
  const status = $("#linkStatus");
  const code = $("#barcode").value.trim();
  if (!code || $("#noBarcode").checked) { status.textContent = "Primeiro leia ou digite o código que você quer vincular."; return; }
  if (canonicalCode(code) === canonicalCode(mainCode)) { status.textContent = "Esse código já pertence a esse produto."; return; }
  if (fromDraft) {
    // Produto ainda não salvo: vale já nesta conferência e é gravado no banco quando você salvar.
    draft.pendingLinks = (draft.pendingLinks || []).filter((link) => link.code !== code).concat({ code, main: canonicalCode(mainCode) });
    persistDraft();
    addCodeLink(code, canonicalCode(mainCode));
    $("#linkSearch").value = "";
    $("#linkResults").innerHTML = "";
    status.textContent = "";
    $("#linkCodeBox").open = false;
    await fillProductDescription("#barcode", "#description", "#formStatus");
    return;
  }
  status.textContent = "Vinculando...";
  const { error } = await supabaseClient.rpc("link_product_code", { p_code: code, p_product_barcode: mainCode });
  if (error) {
    status.textContent = /link_product_code|schema cache|does not exist/i.test(error.message || "")
      ? "Falta executar o SQL de códigos extras no Supabase."
      : (error.message || "Não foi possível vincular.");
    return;
  }
  addCodeLink(code, canonicalCode(mainCode));
  $("#linkSearch").value = "";
  $("#linkResults").innerHTML = "";
  status.textContent = "";
  $("#linkCodeBox").open = false;
  await fillProductDescription("#barcode", "#description", "#formStatus");
  renderProductCatalog();
}

async function unlinkFromCatalog(event) {
  const button = event.target.closest(".unlink-code");
  if (!button) return;
  const code = button.dataset.code;
  if (!confirm(`Desvincular o código ${code}? Ele deixa de contar junto com o produto.`)) return;
  const { error } = await supabaseClient.rpc("unlink_product_code", { p_code: code });
  if (error) { $("#productCatalogStatus").textContent = error.message || "Não foi possível desvincular."; return; }
  removeCodeLink(code);
  $("#productCatalogStatus").textContent = "";
  renderProductCatalog();
}

function validProductPhoto(url) {
  return typeof url === "string" && /^(https?:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(url);
}

function renderProductCatalog() {
  if (currentProfile?.role !== "admin") return;
  const query = $("#productCatalogSearch").value.trim().toLocaleLowerCase("pt-BR");
  const filtered = catalogProducts.filter(product =>
    product.barcode.toLocaleLowerCase("pt-BR").includes(query) ||
    (codesByProduct.get(product.barcode) || []).some(code => code.toLocaleLowerCase("pt-BR").includes(query)) ||
    product.description.toLocaleLowerCase("pt-BR").includes(query));
  const pages = Math.max(1, Math.ceil(filtered.length / catalogPageSize));
  catalogPage = Math.min(catalogPage, pages - 1);
  $("#productCatalogCount").textContent = filtered.length + " de " + catalogProducts.length + " produtos";
  $("#productCatalogRows").innerHTML = filtered.slice(catalogPage * catalogPageSize, (catalogPage + 1) * catalogPageSize)
    .map(product => "<tr><td><div class=\"thumb\">" + (validProductPhoto(product.photo_url)
      ? "<img loading=\"lazy\" src=\"" + escapeHtml(product.photo_url) + "\" alt=\"Foto de " + escapeHtml(product.description) + "\">"
      : "<span>Sem foto</span>") + "</div></td><td>" + escapeHtml(displayBarcode(product.barcode)) + "</td><td>" + escapeHtml(product.description) +
      "</td><td>" + (codesByProduct.get(product.barcode) || []).map(code => "<span class=\"extra-code\">" + escapeHtml(code) +
      " <button type=\"button\" class=\"unlink-code\" data-code=\"" + escapeHtml(code) + "\" aria-label=\"Desvincular " + escapeHtml(code) + "\">×</button></span>").join(" ") +
      "</td><td>" + escapeHtml(product.updated_at ? formatDate(product.updated_at) : "-") + "</td></tr>").join("");
  $("#productCatalogEmpty").hidden = filtered.length > 0;
  $("#productCatalogPrevious").disabled = catalogPage === 0;
  $("#productCatalogNext").disabled = catalogPage >= pages - 1;
  $("#productCatalogPage").textContent = "Página " + (catalogPage + 1) + " de " + pages;
}

bindEvents();
boot();

function bindEvents() {
  $("#productCatalogRows").addEventListener("error", event => {
    if (event.target.tagName !== "IMG") return;
    const fallback = document.createElement("span");
    fallback.textContent = "Foto indisponível";
    event.target.replaceWith(fallback);
  }, true);
  $("#productCatalogSearch").addEventListener("input", () => { catalogPage = 0; renderProductCatalog(); });
  $("#productCatalogRows").addEventListener("click", unlinkFromCatalog);
  $("#linkSearch").addEventListener("input", searchLinkTarget);
  $("#refreshProductCatalog").addEventListener("click", loadProductCatalog);
  $("#productCatalogPrevious").addEventListener("click", () => { catalogPage = Math.max(0, catalogPage - 1); renderProductCatalog(); });
  $("#productCatalogNext").addEventListener("click", () => { catalogPage += 1; renderProductCatalog(); });
  $("#noBarcode").addEventListener("change", () => syncNoBarcode(false, true));
  $("#orderNoBarcode").addEventListener("change", () => syncNoBarcode(true, true));
  bindProductLookup("#barcode", "#description", "#formStatus");
  bindProductLookup("#orderBarcode", "#orderDescription", "#orderStatus");
  $("#loginForm").addEventListener("submit", login);
  $("#logoutButton").addEventListener("click", logout);
  $$(".tab-button").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));

  $("#goToNew").addEventListener("click", () => { if (recordMode === "loss") startNewConference(); showView(recordMode === "loss" ? "losses" : "new"); });
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
  $("#lossArchiveToggle").addEventListener("change", renderHistory);
  $("#resetLosses").addEventListener("click", resetLosses);
  $("#refreshLosses").addEventListener("click", async () => { await loadConferences(); renderHistory(); });
  $("#exportLossExcel").addEventListener("click", () => exportExcel(buildLossSummary()));
  $("#exportLossPdf").addEventListener("click", () => exportPdf(buildLossSummary()));
  $("#barcode").addEventListener("input", showLossBarcodeTotal);
  setInterval(async () => {
    if (currentUser && !savingRecord && document.visibilityState === "visible" && $(".tab-button.active")?.dataset.view === "losses") {
      await loadConferences(); renderHistory();
    }
  }, 20000);
  $("#startScan").addEventListener("click", startScanner);
  $("#stopScan").addEventListener("click", stopScanner);
  $("#barcodePhoto").addEventListener("change", scanCapturedPhoto);
  $("#startOrderScan").addEventListener("click", startOrderScanner);
  $("#stopOrderScan").addEventListener("click", stopScanner);
  $("#orderBarcodePhoto").addEventListener("change", scanCapturedPhoto);

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
  $("#createConferente").addEventListener("click", createConferente);
  $("#generateUserSql").addEventListener("click", generateConferenteSql);
  $("#copyUserSql").addEventListener("click", copyConferenteSql);
}

async function boot() {
  if (!supabaseClient) {
    showLogin("Biblioteca do Supabase não carregou. Verifique a internet.");
    return;
  }
  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) {
    showLogin();
    return;
  }
  await enterApp(data.session.user);
}

async function login(event) {
  event.preventDefault();
  const email = normalizeLogin($("#loginEmail").value);
  const password = $("#loginPassword").value;
  showMessage("#loginStatus", "Entrando...");
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    const invalidCredentials = error.code === "invalid_credentials" || error.message === "Invalid login credentials";
    return showMessage("#loginStatus", invalidCredentials
      ? "Usuário ou senha inválidos."
      : "Não foi possível acessar o serviço de login. Verifique a conexão e se o projeto Supabase está ativo.");
  }
  await enterApp(data.user);
}

async function logout() {
  catalogRequest += 1;
  catalogProducts = [];
  codeToProduct = new Map();
  codesByProduct = new Map();
  $("#productCatalogRows").innerHTML = "";
  $("#productCatalogSearch").value = "";
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  conferences = [];
  losses = [];
  orders = [];
  $("#appShell").classList.add("app-hidden");
  $("#loginView").hidden = false;
}

async function enterApp(user) {
  currentUser = user;
  await loadProfile();
  $("#loginView").hidden = true;
  $("#appShell").classList.remove("app-hidden");
  syncSession();
  syncDraftFields();
  syncOrderFields();
  await loadRemoteData();
  renderAll();
}

function showLogin(message = "") {
  $("#loginView").hidden = false;
  $("#appShell").classList.add("app-hidden");
  $("#loginStatus").textContent = message;
}

async function loadProfile() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id,email,role")
    .eq("id", currentUser.id)
    .single();

  if (error || !data) {
    currentProfile = { id: currentUser.id, email: currentUser.email, role: "conferente" };
    return;
  }
  currentProfile = data;
}

async function loadRemoteData() {
  await Promise.all([loadConferences(), loadOrders(), loadProductCodes()]);
}

async function loadConferences() {
  let query = supabaseClient
    .from("conferences")
    .select("*, conference_items(*)")
    .order("created_at", { ascending: false });

  if (currentProfile?.role === "conferente") {
    query = query.eq("created_by", currentUser.id);
  }

  const { data, error } = await query;
  if (error) {
    if (recordMode === "loss") showMessage("#lossAccumulatedStatus", "Não foi possível atualizar o acumulado. Tente novamente em Atualizar.");
    return false;
  }
  const records = data.map(mapConferenceFromDb);
  conferences = records.filter(record => record.kind !== "loss");
  losses = records.filter(record => record.kind === "loss");
}

async function loadOrders() {
  if (!canSeeOrders()) {
    orders = [];
    return;
  }
  const { data, error } = await supabaseClient
    .from("purchase_orders")
    .select("*, purchase_order_items(*)")
    .order("created_at", { ascending: false });
  if (error) {
    orders = [];
    return;
  }
  orders = data.map(mapOrderFromDb);
}

function syncSession() {
  const labels = { conferente: "Conferente", compras: "Compras", admin: "Administrador" };
  const role = currentProfile?.role || "conferente";
  $("#sessionTitle").textContent = `${currentProfile?.email || currentUser?.email || ""}`;
  $("#roleBadge").textContent = labels[role] || role;

  const allowed = {
    conferente: ["new", "history", "losses"],
    compras: ["orders"],
    admin: ["new", "history", "losses", "orders", "compare", "products", "users"]
  }[role] || ["new", "history"];

  $$(".tab-button").forEach((button) => { button.hidden = !allowed.includes(button.dataset.view); });
  const active = $(".tab-button.active");
  if (!active || active.hidden) showView(allowed[0]);
}

function canSeeOrders() {
  return ["compras", "admin"].includes(currentProfile?.role);
}

function showView(name) {
  if (name === "products" && currentProfile?.role !== "admin") return;
  const targetButton = $(`.tab-button[data-view="${name}"]`);
  if (targetButton?.hidden) return;
  if (["new", "history", "losses"].includes(name)) switchRecordMode(name === "losses" ? "loss" : "conference");
  $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => view.classList.remove("active"));
  if (name === "losses") {
    $("#newView").classList.add("active");
    $("#historyView").classList.add("active");
    renderHistory();
    if (currentUser) loadConferences().then(() => { if (recordMode === "loss") renderHistory(); });
  } else $(`#${name}View`)?.classList.add("active");
  if (name === "products") loadProductCatalog();
  if (name === "history") renderHistory();
  if (name === "orders") renderOrders();
  if (name === "compare") renderCompareOptions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function generateConferenteSql() {
  const username = safeLoginName($("#newUserName").value);
  const fullName = $("#newUserFullName").value.trim();
  const password = $("#newUserPassword").value.trim();
  if (!username) return showMessage("#userStatus", "Informe o usuário do conferente.", $("#newUserName"));
  if (!password) return showMessage("#userStatus", "Informe a senha inicial.", $("#newUserPassword"));

  const email = `${username}@${defaultLoginDomain}`;
  const sql = `-- 1) Primeiro crie este usuário em Authentication > Users:\n-- Email: ${email}\n-- Senha: ${password}\n\n-- 2) Depois rode este SQL para liberar como conferente:\ninsert into public.profiles (id, email, role)\nselect id, email, 'conferente'\nfrom auth.users\nwhere email = '${escapeSql(email)}'\non conflict (id) do update set\n  email = excluded.email,\n  role = 'conferente';\n\n-- Nome para sua referência: ${escapeSql(fullName || username)}`;
  $("#userSqlOutput").textContent = sql;
  showMessage("#userStatus", `Cadastro preparado para ${email}.`);
}

async function createConferente() {
  const username = safeLoginName($("#newUserName").value);
  const fullName = $("#newUserFullName").value.trim();
  const password = $("#newUserPassword").value.trim();
  if (!username) return showMessage("#userStatus", "Informe o usuário do conferente.", $("#newUserName"));
  if (!password || password.length < 6) return showMessage("#userStatus", "Informe uma senha com pelo menos 6 caracteres.", $("#newUserPassword"));

  const email = `${username}@${defaultLoginDomain}`;
  showMessage("#userStatus", "Criando conferente...");
  const { data, error } = await supabaseClient.functions.invoke("criar-conferente", {
    body: { username, full_name: fullName, password }
  });

  if (error) {
    generateConferenteSql();
    return showMessage("#userStatus", "A função ainda não está ativa no Supabase. Use o SQL gerado por enquanto.");
  }

  if (!data?.ok) {
    generateConferenteSql();
    return showMessage("#userStatus", data?.error || "Não foi possível criar o conferente.");
  }

  $("#userSqlOutput").textContent = `Conferente criado com sucesso.\n\nUsuário: ${username}\nE-mail: ${data.email || email}`;
  $("#newUserPassword").value = "";
  showMessage("#userStatus", `Conferente ${username} criado.`);
}

async function copyConferenteSql() {
  const text = $("#userSqlOutput").textContent || "";
  if (!text || text.includes("Preencha os dados")) return showMessage("#userStatus", "Gere o cadastro primeiro.");
  try {
    await navigator.clipboard.writeText(text);
    showMessage("#userStatus", "SQL copiado.");
  } catch {
    showMessage("#userStatus", "Não consegui copiar automaticamente. Selecione o texto e copie manualmente.");
  }
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
  if (recordMode === "loss" && draft.lossSubmission) return showMessage("#formStatus", "Reenvie o lançamento pendente em Salvar perdas antes de adicionar outros itens.");
  const item = collectItem({
    barcode: $("#barcode").value,
    noBarcode: $("#noBarcode").checked,
    description: $("#description").value,
    quantity: $("#quantity").value,
    observation: $("#itemObservation").value,
    photo: currentPhoto
  }, "#formStatus", true);
  if (!item) return;

  // Confere o código para não duplicar a quantidade: o mesmo produto não vira duas linhas na conferência.
  const duplicate = recordMode === "loss" ? null : findItemByBarcode(draft.items, item.barcode, editingItemId);
  const original = editingItemId ? draft.items.find((entry) => entry.id === editingItemId) : null;
  // Ao alterar, só bloqueia se o código foi trocado para um que já existe (conferências antigas com repetição continuam editáveis).
  if (duplicate && editingItemId && original?.barcode !== item.barcode) {
    return showMessage("#formStatus", `O código ${displayBarcode(item.barcode)} já está em outro item (${duplicate.description}, ${duplicate.quantity} un.). Altere aquele item ou exclua um dos dois, para não duplicar a quantidade.`, $("#barcode"));
  }
  if (duplicate && !editingItemId) {
    const total = Number(duplicate.quantity) + item.quantity;
    const question = `O código ${displayBarcode(item.barcode)} já está na conferência:\n${duplicate.description}, ${duplicate.quantity} un.\n\nOK: somar ${item.quantity} un. a esse item (ficam ${total} un.).\nCancelar: não adicionar agora.`;
    if (!confirm(question)) return showMessage("#formStatus", "Item não adicionado. Esse código já está na conferência.", $("#barcode"));
    const nowMerge = new Date().toISOString();
    draft.items = draft.items.map((entry) => entry.id === duplicate.id ? {
      ...entry, quantity: total,
      observation: [entry.observation, item.observation].filter(Boolean).join("; "), updatedAt: nowMerge
    } : entry);
    persistDraft();
    showMessage("#formStatus", `Quantidade somada ao item existente: ${total} un.`);
    resetItemForm();
    renderDraft();
    return;
  }

  const now = new Date().toISOString();
  if (editingItemId) {
    draft.items = draft.items.map((entry) => entry.id === editingItemId ? { ...entry, ...item, updatedAt: now } : entry);
  } else if (recordMode === "loss" && draft.items.some(entry => entry.barcode === item.barcode)) {
    draft.items = draft.items.map(entry => entry.barcode === item.barcode ? {
      ...entry, ...item, quantity: Number(entry.quantity) + item.quantity,
      observation: [entry.observation, item.observation].filter(Boolean).join("; "), updatedAt: now
    } : entry);
  } else {
    draft.items.unshift({ id: makeId(), ...item, createdAt: now, updatedAt: now });
  }

  persistDraft();
  showMessage("#formStatus", editingItemId ? "Item atualizado." : "Item adicionado. Pode registrar o próximo.");
  resetItemForm();
  renderDraft();
}

// Itens com o mesmo código (inclui produto "sem código", cujo código interno vem da descrição).
function findItemByBarcode(items, barcode, ignoreId) {
  if (!barcode) return null;
  return items.find((entry) => entry.id !== ignoreId && entry.barcode === barcode) || null;
}

function repeatedBarcodes(items) {
  const groups = new Map();
  items.forEach((entry) => {
    if (!entry.barcode) return;
    const group = groups.get(entry.barcode) || { barcode: entry.barcode, description: entry.description, lines: 0, units: 0 };
    group.lines += 1;
    group.units += Number(entry.quantity || 0);
    groups.set(entry.barcode, group);
  });
  return [...groups.values()].filter((group) => group.lines > 1);
}

function collectItem(raw, statusSelector, requirePhoto) {
  let barcode = canonicalCode(raw.barcode);
  const description = String(raw.description || "").trim();
  const quantity = Number(raw.quantity);
  const photo = raw.photo || "";
  if (raw.noBarcode && description) barcode = NO_BARCODE_PREFIX + encodeURIComponent(description.normalize("NFC").toLocaleLowerCase("pt-BR").replace(/\s+/g, " "));
  if (!barcode && !raw.noBarcode) return showMessage(statusSelector, "Informe ou leia o código de barras.");
  if (!description) return showMessage(statusSelector, "Informe a descrição da mercadoria.");
  if (!Number.isFinite(quantity) || quantity < 1) return showMessage(statusSelector, "Informe uma quantidade válida.");
  if (requirePhoto && !photo) return showMessage(statusSelector, "Tire uma foto da mercadoria.");
  return { barcode, description, quantity, photo, observation: String(raw.observation || "").trim() };
}

function handleDraftItemAction(event) {
  if (recordMode === "loss" && draft.lossSubmission) return showMessage("#formStatus", "Reenvie o lançamento pendente antes de editar os itens.");
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
    $("#noBarcode").checked = isWithoutBarcode(item.barcode);
    $("#barcode").value = item.barcode;
    syncNoBarcode(false);
    $("#description").value = item.description;
    $("#quantity").value = item.quantity;
    $("#itemObservation").value = item.observation || "";
    currentPhoto = item.photo;
    renderPhotoPreview();
    $("#itemForm .primary-action").textContent = "Salvar alteração";
    $("#barcode").focus();
  }
}

let savingRecord = false;
async function saveConference() {
  if (savingRecord) return;
  savingRecord = true;
  const controls = $$(".main-tabs button, #newView button, #newView input, #newView textarea, #historyView button, #logoutButton");
  const previousDisabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try { await saveConferenceRecord(); }
  catch (error) { showMessage("#conferenceStatus", "Não foi possível salvar. Seu rascunho foi mantido; tente novamente."); }
  finally {
    savingRecord = false;
    controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
  }
}

async function saveConferenceRecord() {
  saveDraftHeader();
  if (recordMode === "loss") return saveLossBatch();
  if (!draft.invoice) return showMessage("#conferenceStatus", recordMode === "loss" ? "Informe a identificação da perda." : "Informe o nome ou número da nota.", $("#invoiceNumber"));
  if (!draft.inspector) return showMessage("#conferenceStatus", "Informe o nome do conferente.", $("#inspectorName"));
  if (!draft.items.length) return showMessage("#conferenceStatus", recordMode === "loss" ? "Adicione pelo menos um item à perda." : "Adicione pelo menos um item à conferência.");

  showMessage("#conferenceStatus", "Salvando no banco...");
  // O mesmo número serve para reenviar sem duplicar se a resposta se perder.
  if (!draft.id && !draft.pendingId) { draft.pendingId = makeUuid(); persistDraft(); }
  const recordId = draft.id || draft.pendingId;
  const items = await Promise.all(draft.items.map((item) => mapConferenceItemToDb(item, recordId)));
  const { data, error } = await supabaseClient.rpc("save_conference", {
    p_id: recordId,
    p_invoice: draft.invoice,
    p_inspector: draft.inspector,
    p_items: items.map(({ conference_id, ...rest }) => rest),
    p_expected_updated_at: draft.id ? (draft.baseUpdatedAt || null) : null
  });
  if (error) {
    const text = error.message || "";
    if (error.code === "PGRST202" || /Could not find the function/i.test(text)) return saveConferenceLegacy();
    if (text.includes("CONFERENCIA_ALTERADA") || text.includes("CONFERENCIA_NAO_ENCONTRADA")) return handleSaveConflict(text);
    return showMessage("#conferenceStatus", `Erro ao salvar: ${text}. Seu rascunho foi mantido.`);
  }

  await flushPendingLinks();
  localStorage.removeItem(keys.draft);
  draft = blankConference();
  syncDraftFields();
  resetItemForm();
  await loadConferences();
  renderAll();
  showView("history");
}

// Outra pessoa salvou esta conferência (ou a apagou) depois que você a abriu: nada foi gravado.
async function handleSaveConflict(text) {
  if (text.includes("CONFERENCIA_NAO_ENCONTRADA")) {
    showMessage("#conferenceStatus", "Esta conferência foi excluída por outra pessoa. Nada foi salvo. Seu rascunho foi mantido.");
    return;
  }
  const reload = confirm("Outra pessoa alterou esta conferência depois que você a abriu. NADA foi salvo, para não apagar o trabalho dela.\n\nOK = carregar a versão atual (suas alterações não salvas serão perdidas).\nCancelar = manter seu rascunho na tela.");
  if (!reload) return showMessage("#conferenceStatus", "Nada foi salvo. Seu rascunho foi mantido; carregue a versão atual antes de salvar de novo.");
  const id = draft.id;
  localStorage.removeItem(keys.draft);
  draft = blankConference();
  await loadConferences();
  renderAll();
  const current = conferences.find((entry) => entry.id === id);
  if (current) await openConference(current);
}

// Forma antiga (em etapas), usada só se a função nova ainda não foi criada no Supabase.
async function saveConferenceLegacy() {
  const { error: schemaError } = await supabaseClient.from("conferences").select("record_kind").limit(0);
  if (schemaError) return showMessage("#conferenceStatus", "Não foi possível verificar o banco de registros. Tente novamente. O rascunho foi mantido.");

  const now = new Date().toISOString();
  const payload = {
    record_kind: recordMode,
    invoice_number: draft.invoice,
    inspector_name: draft.inspector,
    status: "salva",
    created_by: currentUser.id,
    updated_at: now
  };
  if (!draft.id) payload.created_at = now;

  const query = draft.id
    ? supabaseClient.from("conferences").update(payload).eq("id", draft.id).select().single()
    : supabaseClient.from("conferences").insert(payload).select().single();
  const { data: conference, error } = await query;
  if (error) return showMessage("#conferenceStatus", `Erro ao salvar: ${error.message}`);

  // Keep the saved ID so retrying a failed item upload updates this record.
  draft.id = conference.id;
  persistDraft();
  const { error: deleteError } = await supabaseClient.from("conference_items").delete().eq("conference_id", conference.id);
  if (deleteError) return showMessage("#conferenceStatus", `Erro ao atualizar itens: ${deleteError.message}`);
  const items = await Promise.all(draft.items.map((item) => mapConferenceItemToDb(item, conference.id)));
  const { error: itemError } = await supabaseClient.from("conference_items").insert(items);
  if (itemError) return showMessage("#conferenceStatus", `Erro nos itens: ${itemError.message}`);

  localStorage.removeItem(keys.draft);
  draft = blankConference();
  syncDraftFields();
  resetItemForm();
  await loadConferences();
  renderAll();
  showView(recordMode === "loss" ? "losses" : "history");
}

function startNewConference() {
  if (recordMode === "loss" && draft.lossSubmission) return showMessage("#conferenceStatus", "Reenvie o lançamento pendente para confirmar o salvamento antes de limpar.");
  const hasContent = draft.invoice || draft.inspector || draft.items.length;
  if (hasContent && !confirm(recordMode === "loss" ? "Limpar a perda atual e iniciar outra?" : "Limpar a conferência atual e iniciar outra?")) return;
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
  const conference = [...conferences, ...losses].find((entry) => entry.id === card.dataset.id);
  if (!conference) return;
  if (button.classList.contains("open-conference")) openConference(conference);
  if (button.classList.contains("export-excel")) exportExcel(conference);
  if (button.classList.contains("export-pdf")) exportPdf(conference);
  if (button.classList.contains("delete-conference")) deleteConference(conference);
}

async function fetchFreshConference(id) {
  try {
    const { data, error } = await supabaseClient.from("conferences").select("*, conference_items(*)").eq("id", id).maybeSingle();
    if (error) return { error };
    return { record: data ? mapConferenceFromDb(data) : null };
  } catch (error) { return { error }; }
}

async function openConference(cached) {
  if (cached.kind === "loss") return;
  // Pega a versão mais nova no banco: outra pessoa pode ter mexido depois que a lista foi carregada.
  let conference = cached;
  const fresh = await fetchFreshConference(cached.id);
  if (!fresh.error && !fresh.record) {
    alert("Esta conferência não existe mais (pode ter sido excluída). A lista será atualizada.");
    await loadConferences();
    renderAll();
    return;
  }
  if (!fresh.error) conference = fresh.record;
  switchRecordMode(conference.kind === "loss" ? "loss" : "conference");
  const hasOtherDraft = (draft.invoice || draft.inspector || draft.items.length) && draft.id !== conference.id;
  if (hasOtherDraft && !confirm(recordMode === "loss" ? "Substituir o rascunho atual por esta perda?" : "Substituir o rascunho atual por esta conferência?")) return;
  draft = JSON.parse(JSON.stringify(conference));
  draft.baseUpdatedAt = conference.updatedAt;  // texto exato do banco, para saber se mudou depois
  persistDraft();
  syncDraftFields();
  renderDraft();
  showView(recordMode === "loss" ? "losses" : "new");
  const repeated = recordMode === "loss" ? [] : repeatedBarcodes(draft.items);
  if (repeated.length) {
    const list = repeated.map((group) => `${group.description} (${displayBarcode(group.barcode)}: ${group.lines} linhas, ${group.units} un. no total)`).join("; ");
    showMessage("#formStatus", `Atenção: código repetido nesta conferência. Confira para não contar a quantidade duas vezes: ${list}.`);
    clearTimeout(messageTimer);  // este aviso fica na tela até a pessoa agir
  }
}

async function deleteConference(conference) {
  if (conference.kind === "loss") return;
  if (!confirm(`Excluir definitivamente ${conference.kind === "loss" ? "a perda" : "a conferência"} ${conference.invoice}?`)) return;
  const { error } = await supabaseClient.from("conferences").delete().eq("id", conference.id);
  if (error) return alert(`Não foi possível excluir: ${error.message}`);
  await loadConferences();
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
    noBarcode: $("#orderNoBarcode").checked,
    description: $("#orderDescription").value,
    quantity: $("#orderQuantity").value
  }, "#orderStatus", false);
  if (!item) return;

  const unitPrice = parseUnitPrice($("#orderUnitPrice").value);
  if (!Number.isFinite(unitPrice)) return showMessage("#orderStatus", "Informe um valor unitário válido, como 12,50, com até duas casas decimais.");
  item.unitPrice = unitPrice;
  const now = new Date().toISOString();
  delete item.photo;
  if (editingOrderItemId) {
    orderDraft.items = orderDraft.items.map((entry) => entry.id === editingOrderItemId ? { ...entry, ...item, updatedAt: now } : entry);
  } else {
    orderDraft.items.unshift({ id: makeId(), ...item, createdAt: now, updatedAt: now });
  }
  persistOrderDraft();
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
    $("#orderNoBarcode").checked = isWithoutBarcode(item.barcode);
    $("#orderBarcode").value = item.barcode;
    syncNoBarcode(true);
    $("#orderDescription").value = item.description;
    $("#orderQuantity").value = item.quantity;
    $("#orderUnitPrice").value = item.unitPrice == null ? "" : Number(item.unitPrice).toFixed(2).replace(".", ",");
    $("#orderForm .primary-action").textContent = "Salvar alteração";
    $("#orderBarcode").focus();
  }
}

async function saveOrder() {
  saveOrderHeader();
  if (!canSeeOrders()) return showMessage("#saveOrderStatus", "Seu perfil não pode salvar pedido de compra.");
  if (!orderDraft.number) return showMessage("#saveOrderStatus", "Informe o número ou nome do pedido.", $("#orderNumber"));
  if (!orderDraft.buyer) return showMessage("#saveOrderStatus", "Informe o responsável por compras.", $("#buyerName"));
  if (!orderDraft.items.length) return showMessage("#saveOrderStatus", "Adicione pelo menos um item ao pedido.");

  showMessage("#saveOrderStatus", "Salvando pedido no banco...");
  const now = new Date().toISOString();
  const payload = {
    order_number: orderDraft.number,
    buyer_name: orderDraft.buyer,
    status: "aberto",
    created_by: currentUser.id,
    updated_at: now
  };
  if (!orderDraft.id) payload.created_at = now;

  const query = orderDraft.id
    ? supabaseClient.from("purchase_orders").update(payload).eq("id", orderDraft.id).select().single()
    : supabaseClient.from("purchase_orders").insert(payload).select().single();
  const { data: order, error } = await query;
  if (error) return showMessage("#saveOrderStatus", `Erro ao salvar: ${error.message}`);

  await supabaseClient.from("purchase_order_items").delete().eq("purchase_order_id", order.id);
  const items = orderDraft.items.map((item) => ({
    purchase_order_id: order.id,
    barcode: item.barcode,
    description: item.description,
    quantity: item.quantity,
    unit_price: item.unitPrice ?? null
  }));
  const { error: itemError } = await supabaseClient.from("purchase_order_items").insert(items);
  if (itemError) return showMessage("#saveOrderStatus", `Erro nos itens: ${itemError.message}`);

  localStorage.removeItem(keys.orderDraft);
  orderDraft = blankOrder();
  syncOrderFields();
  resetOrderItemForm();
  await loadOrders();
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

async function deleteOrder(order) {
  if (!confirm(`Excluir definitivamente o pedido ${order.number}?`)) return;
  const { error } = await supabaseClient.from("purchase_orders").delete().eq("id", order.id);
  if (error) return alert(`Não foi possível excluir: ${error.message}`);
  await loadOrders();
  renderAll();
}

async function mapConferenceItemToDb(item, conferenceId) {
  const isNewPhoto = item.photo?.startsWith("data:image");
  const uploaded = isNewPhoto ? await uploadPhoto(item.photo, conferenceId, item.id) : { path: item.photoPath || "", url: item.photo || "" };
  return {
    conference_id: conferenceId,
    barcode: item.barcode,
    description: item.description,
    quantity: item.quantity,
    observation: item.observation || "",
    photo_path: uploaded.path,
    photo_url: uploaded.url || item.photo
  };
}

async function uploadPhoto(dataUrl, conferenceId, itemId) {
  if (!dataUrl?.startsWith("data:image")) return { path: "", url: "" };
  try {
    const blob = dataUrlToBlob(dataUrl);
    const path = `${currentUser.id}/${conferenceId}/${itemId || makeId()}.jpg`;
    const { error } = await supabaseClient.storage.from("mercadoria-fotos").upload(path, blob, {
      contentType: "image/jpeg",
      upsert: true
    });
    if (error) throw error;
    const { data } = supabaseClient.storage.from("mercadoria-fotos").getPublicUrl(path);
    return { path, url: data.publicUrl };
  } catch (error) {
    return { path: "", url: dataUrl };
  }
}

async function exportExcel(conference) {
  if (!window.ExcelJS) return alert("O recurso de Excel não carregou. Verifique a internet e tente novamente.");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(conference.kind === "loss" ? "Perdas" : "Conferência", { views: [{ state: "frozen", ySplit: 5 }] });
  sheet.columns = [{ key: "code", width: 22 }, { key: "description", width: 42 }, { key: "quantity", width: 14 }, { key: "date", width: 22 }, { key: "photo", width: 22 }, { key: "observation", width: 45 }];
  sheet.addRow([conference.kind === "loss" ? "REGISTRO DE PERDAS" : "CONFERÊNCIA DE MERCADORIAS"]);
  sheet.mergeCells("A1:F1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF0F766E" } };
  sheet.addRow([conference.kind === "loss" ? "Identificação" : "Nota", conference.invoice]);
  sheet.addRow(["Conferente", conference.inspector]);
  sheet.addRow(["Salva em", formatDate(conference.savedAt || conference.updatedAt)]);
  const header = sheet.addRow(["Código", "Descrição", "Quantidade", "Registrado em", "Foto", "Observação"]);
  styleHeader(header);
  conference.items.forEach((item) => {
    const row = sheet.addRow([codesText(item.barcode), item.description, item.quantity, formatDate(item.updatedAt), "", item.observation || ""]);
    row.height = 72;
    if (item.photo?.startsWith("data:image")) {
      try {
        const imageId = workbook.addImage({ base64: item.photo, extension: item.photo.includes("image/png") ? "png" : "jpeg" });
        sheet.addImage(imageId, { tl: { col: 4.08, row: row.number - 0.92 }, ext: { width: 120, height: 88 } });
      } catch (error) { row.getCell(5).value = "Foto não incorporada"; }
    } else if (item.photo) {
      row.getCell(5).value = item.photo;
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
  sheet.columns = [{ key: "code", width: 22 }, { key: "description", width: 42 }, { key: "quantity", width: 16 }, { key: "unitPrice", width: 20 }];
  sheet.addRow(["PEDIDO DE COMPRA"]);
  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF0F766E" } };
  sheet.addRow(["Pedido", order.number]);
  sheet.addRow(["Compras", order.buyer]);
  const header = sheet.addRow(["Código", "Descrição", "Quantidade pedida", "Valor unitário (R$)"]);
  styleHeader(header);
  order.items.forEach((item) => sheet.addRow([codesText(item.barcode), item.description, item.quantity, item.unitPrice ?? null]));
  sheet.getColumn(4).numFmt = '"R$" #,##0.00';
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(buffer, `${safeName(order.number)}-pedido.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

function exportPdf(conference) {
  printReport({
    title: conference.kind === "loss" ? "Registro de perdas" : "Conferência de mercadorias",
    meta: [[conference.kind === "loss" ? "Identificação" : "Nota", conference.invoice], ["Conferente", conference.inspector], ["Data", formatDate(conference.savedAt || conference.updatedAt)]],
    headers: ["Código", "Descrição", "Qtd.", "Foto", "Observação"],
    rows: conference.items.map((item) => [codesHtml(item.barcode), `<strong>${escapeHtml(item.description)}</strong>`, item.quantity, item.photo ? `<img src="${item.photo}" alt="Foto">` : "Sem foto", escapeHtml(item.observation || "")]),
    footer: `${conference.items.length} itens · ${sumUnits(conference.items)} unidades`
  });
}

function exportOrderPdf(order) {
  printReport({
    title: "Pedido de compra",
    meta: [["Pedido", order.number], ["Compras", order.buyer], ["Data", formatDate(order.savedAt || order.updatedAt)]],
    headers: ["Código", "Descrição", "Quantidade pedida", "Valor unitário"],
    rows: order.items.map((item) => [codesHtml(item.barcode), `<strong>${escapeHtml(item.description)}</strong>`, item.quantity, formatUnitPrice(item.unitPrice)]),
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
      <span><strong>${escapeHtml(comparison.order.number)}</strong> pedido</span>
      <span><strong>${escapeHtml(comparison.conference.invoice)}</strong> conferência</span>
      <span><strong>${comparison.rows.filter((row) => row.status !== "OK").length}</strong> divergências</span>
    </div>
    <div class="table-wrap">
      <table class="compare-table">
        <thead><tr><th>Código</th><th>Descrição</th><th>Pedido</th><th>Recebido</th><th>Dif.</th><th>Status</th></tr></thead>
        <tbody>${comparison.rows.map((row) => `<tr class="${row.status === "OK" ? "ok" : "warn"}"><td>${codesHtml(row.barcode)}</td><td>${escapeHtml(row.description)}</td><td>${row.ordered}</td><td>${row.received}</td><td>${row.diff}</td><td>${row.status}</td></tr>`).join("")}</tbody>
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
    rows: lastComparison.rows.map((row) => [codesHtml(row.barcode), `<strong>${escapeHtml(row.description)}</strong>`, row.ordered, row.received, row.diff, row.status]),
    footer: `${lastComparison.rows.filter((row) => row.status !== "OK").length} divergências`
  });
}

function printReport({ title, meta, headers, rows, footer }) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return alert("Permita a abertura de janelas para gerar o PDF.");
  const metaHtml = meta.map(([label, value]) => `<p class="meta"><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</p>`).join("");
  const headHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowsHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${typeof cell === "number" ? cell : String(cell)}</td>`).join("")}</tr>`).join("");
  const appUrl = JSON.stringify(location.href.split("#")[0]).replace(/</g, "\\u003c");
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
    <style>@page{size:A4;margin:12mm}body{font:12px Arial;color:#1f2933}h1{color:#0f766e;margin-bottom:8px}.meta{margin:3px 0}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:middle}th{background:#0f766e;color:white}img{width:110px;height:82px;object-fit:cover}.footer{margin-top:12px;color:#64748b}.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.bar button{min-height:44px;padding:0 16px;font:600 15px Arial;border:2px solid #0f766e;border-radius:8px;background:#0f766e;color:#fff;cursor:pointer}.bar button.secondary{background:#fff;color:#0f766e}.table-scroll{overflow-x:auto}@media print{.bar,button{display:none}}</style></head><body>
    <div class="bar"><button type="button" id="voltar">&larr; Voltar às conferências</button><button type="button" id="imprimir" class="secondary">Imprimir / salvar PDF</button></div>
    <h1>${escapeHtml(title)}</h1>${metaHtml}
    <div class="table-scroll"><table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p class="footer">${escapeHtml(footer)}</p>
    <script>
    document.getElementById("voltar").onclick=()=>{window.close();setTimeout(()=>{if(!window.closed)location.href=${appUrl}},250)};
    document.getElementById("imprimir").onclick=()=>window.print();
    <\/script></body></html>`);
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
    node.querySelector(".code-line").textContent = `Código: ${codesText(item.barcode)}` + (showPhoto ? "" : ` · Valor unitário: ${formatUnitPrice(item.unitPrice)}`);
    const observation = node.querySelector(".observation-line");
    observation.hidden = !showPhoto || !item.observation;
    observation.textContent = item.observation ? `Observação: ${item.observation}` : "";
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
  const lossMode = recordMode === "loss";
  $("#lossAccumulated").hidden = !lossMode;
  if (lossMode) renderLossSummary();
  const records = lossMode ? losses.filter(entry => $("#lossArchiveToggle").checked ? !!entry.closedAt : !entry.closedAt) : conferences;
  const filtered = records.filter((entry) => [entry.invoice, entry.inspector, ...entry.items.flatMap((item) => [displayBarcode(item.barcode), item.description])]
    .some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query)));
  renderCards("#conferenceList", "#historyEmpty", filtered, "conference");
}

function renderOrders() {
  const query = $("#orderSearch").value.trim().toLocaleLowerCase("pt-BR");
  const filtered = orders.filter((entry) => [entry.number, entry.buyer, ...entry.items.flatMap((item) => [displayBarcode(item.barcode), item.description])]
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
    if (record.kind === "loss") {
      node.querySelector(".open-conference").hidden = true;
      node.querySelector(".delete-conference").hidden = true;
      node.querySelector(".card-invoice").textContent = record.closedAt ? `Período encerrado em ${formatDate(record.closedAt)}` : "Lançamento no acumulado";
    }
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
  $("#inspectorName").value = draft.inspector || currentUser?.email?.split("@")[0] || "";
  if (!draft.inspector) saveDraftHeader();
  updateDraftTitle();
}

function syncOrderFields() {
  $("#orderNumber").value = orderDraft.number || "";
  $("#buyerName").value = orderDraft.buyer || currentUser?.email?.split("@")[0] || "";
  if (!orderDraft.buyer) saveOrderHeader();
  updateOrderTitle();
}

function updateDraftTitle() { $("#draftTitle").textContent = draft.id ? `Editando: ${draft.invoice}` : recordMode === "loss" ? "Nova perda" : "Nova conferência"; }
function updateOrderTitle() { $("#orderTitle").textContent = orderDraft.id ? `Editando: ${orderDraft.number}` : "Novo pedido de compra"; }

function resetItemForm() {
  productLookups.set("#barcode", {});
  delete $("#description").dataset.productDescription;
  editingItemId = null;
  currentPhoto = "";
  $("#itemForm").reset();
  $("#noBarcode").checked = false;
  syncNoBarcode();
  $("#quantity").value = "";
  $("#itemForm .primary-action").textContent = "Adicionar item";
  renderPhotoPreview();
}

function resetOrderItemForm() {
  productLookups.set("#orderBarcode", {});
  delete $("#orderDescription").dataset.productDescription;
  editingOrderItemId = null;
  $("#orderNoBarcode").checked = false;
  syncNoBarcode(true);
  $("#orderBarcode").value = "";
  $("#orderDescription").value = "";
  $("#orderQuantity").value = "";
  $("#orderUnitPrice").value = "";
  $("#orderForm .primary-action").textContent = "Adicionar item";
}

function renderPhotoPreview() {
  $("#photoPreview").innerHTML = currentPhoto ? `<img src="${currentPhoto}" alt="Foto da mercadoria">` : "<span>Sem foto</span>";
}

async function startScanner() {
  scannerMode = "conference";
  return startScannerFor(getScannerConfig());
}

async function startOrderScanner() {
  scannerMode = "order";
  return startScannerFor(getScannerConfig());
}

async function startScannerFor(config) {
  if (!window.isSecureContext || !window.Html5Qrcode) return openPhotoScanner();
  try {
    scanner = new Html5Qrcode(config.readerId);
    $(config.readerSelector).classList.add("active");
    $(config.fallbackSelector).hidden = true;
    $(config.startSelector).disabled = true;
    $(config.stopSelector).disabled = false;
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
  $$(".reader-mount").forEach((reader) => reader.classList.remove("active"));
  ["#scannerFallback", "#orderScannerFallback"].forEach((selector) => {
    const fallback = $(selector);
    if (fallback) fallback.hidden = false;
  });
  ["#startScan", "#startOrderScan"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = false;
  });
  ["#stopScan", "#stopOrderScan"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = true;
  });
}

function openPhotoScanner() {
  const config = getScannerConfig();
  setScanStatus("Fotografe o código de barras de perto.");
  $(config.photoSelector).value = "";
  $(config.photoSelector).click();
}

async function scanCapturedPhoto() {
  const config = getScannerConfig();
  const file = $(config.photoSelector).files?.[0];
  if (!file || !window.Html5Qrcode) return;
  const fileScanner = new Html5Qrcode(config.readerId);
  try {
    setScanStatus("Lendo código...");
    handleBarcode(await fileScanner.scanFile(file, false));
  } catch (error) {
    setScanStatus("Não consegui ler. Tente outra foto ou digite o código.");
  } finally {
    try { await fileScanner.clear(); } catch (error) { /* nada para limpar */ }
  }
}

async function handleBarcode(value) {
  const config = getScannerConfig();
  const code = String(value || "").trim();
  if (!code) return;
  $(scannerMode === "order" ? "#orderNoBarcode" : "#noBarcode").checked = false;
  syncNoBarcode(scannerMode === "order");
  const description = $(config.nextSelector);
  if ($(config.inputSelector).value.trim() !== code && description.dataset.productDescription === description.value) description.value = "";
  delete description.dataset.productDescription;
  $(config.inputSelector).value = code;
  stopScanner();
  setScanStatus(`Código lido: ${code}`);
  $(config.nextSelector).focus();
  const found = await fillProductDescription(config.inputSelector, config.nextSelector, config.statusSelector);
  if (found && document.activeElement === $(config.nextSelector)) {
    $(scannerMode === "order" ? "#orderQuantity" : "#quantity").focus();
  }
}

function getScannerConfig() {
  return scannerMode === "order"
    ? {
      readerId: "orderBarcodeReader",
      readerSelector: "#orderBarcodeReader",
      fallbackSelector: "#orderScannerFallback",
      startSelector: "#startOrderScan",
      stopSelector: "#stopOrderScan",
      photoSelector: "#orderBarcodePhoto",
      statusSelector: "#orderScanStatus",
      inputSelector: "#orderBarcode",
      nextSelector: "#orderDescription"
    }
    : {
      readerId: "barcodeReader",
      readerSelector: "#barcodeReader",
      fallbackSelector: "#scannerFallback",
      startSelector: "#startScan",
      stopSelector: "#stopScan",
      photoSelector: "#barcodePhoto",
      statusSelector: "#scanStatus",
      inputSelector: "#barcode",
      nextSelector: "#description"
    };
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

function mapConferenceFromDb(row) {
  return {
    id: row.id,
    kind: row.record_kind || "conference",
    closedAt: row.loss_closed_at || null,
    invoice: row.invoice_number,
    inspector: row.inspector_name,
    savedAt: row.updated_at || row.created_at,
    updatedAt: row.updated_at,
    items: (row.conference_items || []).map((item) => ({
      id: item.id,
      barcode: item.barcode,
      description: item.description,
      quantity: Number(item.quantity),
      photo: item.photo_url || "",
      photoPath: item.photo_path || "",
      observation: item.observation || "",
      createdAt: item.created_at,
      updatedAt: item.created_at
    }))
  };
}

function mapOrderFromDb(row) {
  return {
    id: row.id,
    number: row.order_number,
    buyer: row.buyer_name,
    savedAt: row.updated_at || row.created_at,
    updatedAt: row.updated_at,
    items: (row.purchase_order_items || []).map((item) => ({
      id: item.id,
      barcode: item.barcode,
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: item.unit_price == null ? null : Number(item.unit_price),
      createdAt: item.created_at,
      updatedAt: item.created_at
    }))
  };
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function persistDraft() { return writeJson(keys.draft, draft, "#formStatus"); }
function persistOrderDraft() { return writeJson(keys.orderDraft, orderDraft, "#orderStatus"); }
function sumUnits(items) { return items.reduce((sum, item) => sum + Number(item.quantity || 0), 0); }
function makeUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function makeId() { return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formatDate(value) { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function safeName(value) { return String(value).replace(/[\\/:*?"<>|]+/g, "-").trim() || "arquivo"; }
function safeLoginName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .toLowerCase();
}
function escapeSql(value) { return String(value ?? "").replace(/'/g, "''"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
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
function setScanStatus(text) {
  const config = getScannerConfig();
  $(config.statusSelector).textContent = text;
}
function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
}
function normalizeLogin(value) {
  const login = String(value || "").trim().toLowerCase();
  return login.includes("@") ? login : `${login}@${defaultLoginDomain}`;
}

function parseUnitPrice(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(text)) return NaN;
  return Math.round(Number(text.replace(",", ".")) * 100) / 100;
}

function formatUnitPrice(value) {
  return value == null || !Number.isFinite(Number(value)) ? "Não informado" :
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value));
}


// Conference and loss entry share the same editor, scanner, photos and reports.
// Each mode has an independent persisted draft and a separate history.
function switchRecordMode(nextMode) {
  if (recordMode !== nextMode) {
    saveDraftHeader();
    recordMode = nextMode;
    keys.draft = nextMode === "loss" ? lossDraftKey : conferenceDraftKey;
    draft = readJson(keys.draft, blankConference());
    resetItemForm();
    $("#conferenceSearch").value = "";
    $("#conferenceStatus").textContent = "";
    syncDraftFields();
  }
  const loss = recordMode === "loss";
  $("#invoiceNumber").closest("label").hidden = loss;
  $("#lossAccumulated").hidden = !loss;
  $("#resetLosses").hidden = !loss || currentProfile?.role !== "admin";
  $("#lossBarcodeTotal").hidden = !loss;
  $("#invoiceLabel").textContent = loss ? "Identificação da perda" : "Nome ou número da nota";
  $("#invoiceNumber").placeholder = loss ? "Ex.: Perdas de 31/10 — hortifruti" : "Ex.: NF 12345";
  $("#recordHelp").textContent = loss ? "O mesmo código soma no acumulado ao salvar. Somente o administrador pode zerar o período." : "Registre a nota e os dados da mercadoria recebida.";
  $("#recordEyebrow").textContent = loss ? "Mercadoria perdida" : "Mercadoria recebida";
  $("#itemsEyebrow").textContent = loss ? "Itens da perda" : "Itens da nota";
  $("#currentListTitle").textContent = loss ? "Perda atual" : "Conferência atual";
  $("#saveConference").textContent = loss ? "Salvar perdas no acumulado" : "Salvar conferência";
  $("#historyTitle").textContent = loss ? "Lançamentos de perdas" : "Conferências salvas";
  $("#goToNew").textContent = loss ? "+ Nova perda" : "+ Nova conferência";
  $("#historyEmpty strong").textContent = loss ? "Nenhuma perda encontrada." : "Nenhuma conferência encontrada.";
  $("#historyEmpty p").textContent = loss ? "As perdas salvas aparecerão aqui." : "As conferências salvas aparecerão aqui.";
  $("#conferenceSearch").placeholder = loss ? "Pesquisar perda, conferente, código ou descrição" : "Pesquisar nota, conferente, código ou descrição";
  renderDraft();
}


function buildLossSummary(records = losses.filter(record => !record.closedAt)) {
  const products = new Map();
  for (const record of records) for (const item of record.items) {
    const previous = products.get(item.barcode);
    if (previous) {
      previous.quantity += Number(item.quantity);
      if (item.observation && !previous.notes.has(item.observation)) {
        previous.notes.add(item.observation);
        previous.observation = [...previous.notes].join("; ");
      }
    } else products.set(item.barcode, {...item, quantity: Number(item.quantity), notes: new Set(item.observation ? [item.observation] : [])});
  }
  return {kind:"loss", invoice:"Perdas acumuladas", inspector:currentProfile?.role === "admin" ? "Todos os colaboradores" : currentUser?.email || "", savedAt:new Date().toISOString(), items:[...products.values()].sort((a,b)=>a.description.localeCompare(b.description,"pt-BR"))};
}

function renderLossSummary() {
  const summary = buildLossSummary();
  $("#lossAccumulatedTotal").textContent = `${summary.items.length} ${summary.items.length === 1 ? "produto" : "produtos"} · ${sumUnits(summary.items)} unidades acumuladas`;
  $("#lossAccumulatedRows").innerHTML = summary.items.map(item => `<tr><td>${escapeHtml(displayBarcode(item.barcode))}</td><td>${escapeHtml(item.description)}</td><td><strong>${item.quantity}</strong></td><td>${escapeHtml(item.observation || "")}</td></tr>`).join("");
  $("#lossAccumulatedEmpty").hidden = summary.items.length > 0;
  $("#resetLosses").hidden = currentProfile?.role !== "admin";
  showLossBarcodeTotal();
}

function showLossBarcodeTotal() {
  if (recordMode !== "loss") return;
  const barcode = $("#barcode").value.trim();
  const saved = buildLossSummary().items.find(item => item.barcode === barcode)?.quantity || 0;
  const pending = draft.items.filter(item => item.barcode === barcode).reduce((total,item)=>total+Number(item.quantity),0);
  $("#lossBarcodeTotal").textContent = barcode ? `Este código: ${saved} unidades salvas + ${pending} neste lançamento. A quantidade informada será acrescentada ao salvar.` : "Códigos repetidos somam no acumulado ao salvar.";
}

async function saveLossBatch() {
  if (!draft.inspector) return showMessage("#conferenceStatus", "Informe o nome do conferente.");
  if (!draft.items.length) return showMessage("#conferenceStatus", "Adicione pelo menos um item à perda.");
  if (draft.id) return showMessage("#conferenceStatus", "Inicie um novo lançamento para acrescentar perdas.");
  if (!draft.lossSubmission) {
    draft.lossSubmission = {requestId:makeId(),inspector:draft.inspector,items:JSON.parse(JSON.stringify(draft.items))};
    if (!persistDraft()) { delete draft.lossSubmission; return; }
  }
  showMessage("#conferenceStatus", "Somando perdas no banco...");
  const submission = draft.lossSubmission;
  const items = await Promise.all(submission.items.map(item => mapConferenceItemToDb(item, submission.requestId)));
  const {error} = await supabaseClient.rpc("add_loss_batch", {p_request_id:submission.requestId,p_inspector:submission.inspector,p_items:items});
  if (error) return showMessage("#conferenceStatus", `Não foi possível confirmar: ${error.message}. Toque em Salvar perdas para reenviar o mesmo lançamento, sem duplicar.`);
  localStorage.removeItem(keys.draft);
  draft = blankConference(); syncDraftFields(); resetItemForm();
  await loadConferences(); renderAll(); showView("losses");
  showMessage("#conferenceStatus", "Perdas acrescentadas ao acumulado.");
}

async function resetLosses() {
  if (currentProfile?.role !== "admin" || savingRecord) return;
  if (!confirm("Zerar as perdas acumuladas de todos os colaboradores? Os lançamentos anteriores serão mantidos nos períodos encerrados.")) return;
  const button = $("#resetLosses"); button.disabled = true;
  try {
    const {error} = await supabaseClient.rpc("close_loss_period");
    if (error) return showMessage("#lossAccumulatedStatus", `Não foi possível zerar: ${error.message}`);
    await loadConferences(); renderHistory();
    showMessage("#lossAccumulatedStatus", "Acumulado zerado. O histórico foi mantido nos períodos encerrados.");
  } catch (error) { showMessage("#lossAccumulatedStatus", "Não foi possível confirmar. Atualize os dados antes de tentar novamente."); }
  finally { button.disabled = false; }
}
