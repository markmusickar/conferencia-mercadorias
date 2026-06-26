const storageKey = "conferencia-mercadorias-v1";

const form = document.querySelector("#itemForm");
const barcodeInput = document.querySelector("#barcode");
const descriptionInput = document.querySelector("#description");
const quantityInput = document.querySelector("#quantity");
const photoInput = document.querySelector("#photo");
const photoPreview = document.querySelector("#photoPreview");
const itemsList = document.querySelector("#itemsList");
const itemTemplate = document.querySelector("#itemTemplate");
const emptyState = document.querySelector("#emptyState");
const searchInput = document.querySelector("#search");
const totalItems = document.querySelector("#totalItems");
const totalUnits = document.querySelector("#totalUnits");
const exportCsvButton = document.querySelector("#exportCsv");
const clearAllButton = document.querySelector("#clearAll");
const clearFormButton = document.querySelector("#clearForm");
const startScanButton = document.querySelector("#startScan");
const stopScanButton = document.querySelector("#stopScan");
const scannerVideo = document.querySelector("#scannerVideo");
const scannerFallback = document.querySelector("#scannerFallback");
const barcodePhotoInput = document.querySelector("#barcodePhoto");
const scanStatus = document.querySelector("#scanStatus");
const formStatus = document.querySelector("#formStatus");
const barcodeReaderId = "barcodeReader";
const barcodeReader = document.querySelector("#barcodeReader");

let items = loadItems();
let editingId = null;
let currentPhoto = "";
let scanStream = null;
let scanTimer = null;
let detector = null;
let html5Scanner = null;
let lastDetectedCode = "";
let statusTimer = null;

render();
setupBarcodeDetector();

startScanButton.addEventListener("click", startScanner);

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const barcode = barcodeInput.value.trim();
  const description = descriptionInput.value.trim();
  const quantity = Number(quantityInput.value);

  if (!barcode) {
    showFormStatus("Leia ou digite o código de barras antes de adicionar.");
    barcodeInput.focus();
    return;
  }

  if (!description) {
    showFormStatus("Informe a descrição da mercadoria.");
    descriptionInput.focus();
    return;
  }

  if (!Number.isFinite(quantity) || quantity < 1) {
    showFormStatus("Informe uma quantidade válida.");
    quantityInput.focus();
    return;
  }

  if (!currentPhoto) {
    showFormStatus("Tire ou selecione uma foto da mercadoria antes de salvar.");
    photoInput.focus();
    return;
  }

  if (editingId) {
    items = items.map((item) => {
      if (item.id !== editingId) return item;
      return {
        ...item,
        barcode,
        description,
        quantity,
        photo: currentPhoto,
        updatedAt: new Date().toISOString()
      };
    });
  } else {
    const existing = items.find((item) => item.barcode === barcode);
    if (existing) {
      items = items.map((item) => {
        if (item.id !== existing.id) return item;
        return {
          ...item,
          description,
          quantity: item.quantity + quantity,
          photo: currentPhoto || item.photo,
          updatedAt: new Date().toISOString()
        };
      });
    } else {
      items.unshift({
        id: crypto.randomUUID(),
        barcode,
        description,
        quantity,
        photo: currentPhoto,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }

  saveItems();
  showFormStatus(editingId ? "Item atualizado. Pronto para o próximo." : "Item adicionado. Pronto para o próximo.");
  resetForm();
  render();
});

photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  if (!file) {
    currentPhoto = "";
    renderPhotoPreview();
    return;
  }

  currentPhoto = await resizeImage(file);
  renderPhotoPreview();
});

itemsList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const card = event.target.closest(".item-card");
  if (!button || !card) return;

  const item = items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;

  if (button.classList.contains("remove")) {
    items = items.filter((entry) => entry.id !== item.id);
    saveItems();
    render();
    return;
  }

  if (button.classList.contains("edit")) {
    editingId = item.id;
    barcodeInput.value = item.barcode;
    descriptionInput.value = item.description;
    quantityInput.value = item.quantity;
    currentPhoto = item.photo;
    renderPhotoPreview();
    form.querySelector(".primary-action").textContent = "Salvar item";
    barcodeInput.focus();
  }
});

searchInput.addEventListener("input", render);
clearFormButton.addEventListener("click", resetForm);

clearAllButton.addEventListener("click", () => {
  if (!items.length) return;
  const confirmed = window.confirm("Apagar todos os itens conferidos?");
  if (!confirmed) return;
  items = [];
  saveItems();
  render();
});

exportCsvButton.addEventListener("click", () => {
  const rows = [
    ["codigo", "descricao", "quantidade", "atualizado_em"],
    ...items.map((item) => [
      item.barcode,
      item.description,
      String(item.quantity),
      formatDate(item.updatedAt)
    ])
  ];

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `conferencia-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

stopScanButton.addEventListener("click", stopScanner);
barcodePhotoInput.addEventListener("change", readBarcodeFromCapturedPhoto);

async function startScanner() {
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    openBarcodePhotoCapture();
    return;
  }

  if (!detector && window.Html5Qrcode) {
    await startHtml5QrcodeScanner();
    return;
  }

  if (!detector) {
    openBarcodePhotoCapture();
    return;
  }

  try {
    setScanStatus("Aponte a câmera para o código de barras.");
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    scannerVideo.srcObject = scanStream;
    await scannerVideo.play();
    scannerVideo.hidden = false;
    scannerFallback.hidden = true;
    startScanButton.disabled = true;
    stopScanButton.disabled = false;
    scanTimer = window.setInterval(detectBarcode, 350);
  } catch (error) {
    openBarcodePhotoCapture();
  }
}

async function startHtml5QrcodeScanner() {
  try {
    setScanStatus("Aponte a câmera traseira para o código de barras.");
    scannerFallback.hidden = true;
    scannerVideo.hidden = true;
    barcodeReader.classList.add("active");
    barcodeReader.setAttribute("aria-hidden", "false");
    startScanButton.disabled = true;
    stopScanButton.disabled = false;

    html5Scanner = new Html5Qrcode(barcodeReaderId, {
      formatsToSupport: getHtml5BarcodeFormats()
    });

    await html5Scanner.start(
      { facingMode: "environment" },
      { fps: 8, qrbox: { width: 280, height: 160 }, disableFlip: true },
      (decodedText) => handleBarcodeRead(decodedText)
    );
  } catch (error) {
    stopScanner();
    openBarcodePhotoCapture();
  }
}

function openBarcodePhotoCapture() {
  setScanStatus("Tire uma foto nítida do código de barras.");
  barcodePhotoInput.value = "";
  barcodePhotoInput.click();
}

async function readBarcodeFromCapturedPhoto() {
  const file = barcodePhotoInput.files?.[0];
  if (!file) return;

  try {
    setScanStatus("Lendo código da foto...");
    const rawValue = await decodeBarcodeFromFile(file);

    if (!rawValue) {
      setScanStatus("Não encontrei o código. Fotografe mais perto, com o código reto e bem iluminado.");
      barcodeInput.focus();
      return;
    }

    handleBarcodeRead(rawValue);
  } catch (error) {
    setScanStatus("Não consegui ler essa foto. Digite o código ou tente outra imagem.");
    barcodeInput.focus();
  }
}

async function detectBarcode() {
  if (!detector || scannerVideo.readyState < 2) return;

  try {
    const codes = await detector.detect(scannerVideo);
    const rawValue = codes[0]?.rawValue?.trim();
    if (!rawValue || rawValue === lastDetectedCode) return;

    lastDetectedCode = rawValue;
    handleBarcodeRead(rawValue);
    setTimeout(() => {
      lastDetectedCode = "";
    }, 1800);
  } catch (error) {
    stopScanner();
  }
}

function stopScanner() {
  if (scanTimer) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }

  if (scanStream) {
    scanStream.getTracks().forEach((track) => track.stop());
    scanStream = null;
  }

  scannerVideo.pause();
  scannerVideo.srcObject = null;
  scannerVideo.hidden = true;
  if (html5Scanner) {
    const scanner = html5Scanner;
    html5Scanner = null;
    scanner.stop().catch(() => {}).finally(() => scanner.clear().catch(() => {}));
  }
  barcodeReader.classList.remove("active");
  barcodeReader.setAttribute("aria-hidden", "true");
  scannerFallback.hidden = false;
  startScanButton.disabled = false;
  stopScanButton.disabled = true;
  setScanStatus("");
}

function handleBarcodeRead(rawValue) {
  const barcode = rawValue?.trim();
  if (!barcode) return;

  barcodeInput.value = barcode;
  setScanStatus(`Código lido: ${barcode}`);
  startScanButton.classList.remove("ready-next");
  stopScanner();
  setScanStatus(`Código lido: ${barcode}`);
  descriptionInput.focus();
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const filteredItems = items.filter((item) => {
    return (
      item.barcode.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
    );
  });

  itemsList.innerHTML = "";
  emptyState.hidden = filteredItems.length > 0;

  filteredItems.forEach((item) => {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.querySelector("h3").textContent = item.description;
    node.querySelector(".qty-pill").textContent = `${item.quantity} un.`;
    node.querySelector(".code-line").textContent = `Código: ${item.barcode}`;
    node.querySelector(".date-line").textContent = `Atualizado: ${formatDate(item.updatedAt)}`;

    const thumb = node.querySelector(".thumb");
    if (item.photo) {
      const image = document.createElement("img");
      image.alt = item.description;
      image.src = item.photo;
      thumb.append(image);
    }

    itemsList.append(node);
  });

  totalItems.textContent = String(items.length);
  totalUnits.textContent = String(items.reduce((sum, item) => sum + item.quantity, 0));
}

function renderPhotoPreview() {
  photoPreview.innerHTML = "";
  if (!currentPhoto) {
    const text = document.createElement("span");
    text.textContent = "Sem foto";
    photoPreview.append(text);
    return;
  }

  const image = document.createElement("img");
  image.alt = "Foto da mercadoria";
  image.src = currentPhoto;
  photoPreview.append(image);
}

function resetForm() {
  editingId = null;
  currentPhoto = "";
  form.reset();
  quantityInput.value = "1";
  form.querySelector(".primary-action").textContent = "Adicionar item";
  renderPhotoPreview();
  barcodeInput.focus();
  startScanButton.classList.add("ready-next");
}

function loadItems() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || [];
  } catch (error) {
    return [];
  }
}

function saveItems() {
  localStorage.setItem(storageKey, JSON.stringify(items));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function resizeImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const maxSize = 920;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function decodeBarcodeFromFile(file) {
  const libraryResult = await decodeWithHtml5Qrcode(file);
  if (libraryResult) return libraryResult;

  const quaggaResult = await decodeWithQuagga(file);
  if (quaggaResult) return quaggaResult;

  if (!detector) return "";

  const image = await fileToImage(file);
  return decodeBarcodeFromImage(image);
}

async function decodeWithHtml5Qrcode(file) {
  if (!window.Html5Qrcode) {
    setScanStatus("Leitor extra não carregou. Verifique a internet do celular e atualize a página.");
    return "";
  }

  let scanner = null;
  try {
    scanner = new Html5Qrcode(barcodeReaderId, {
      formatsToSupport: getHtml5BarcodeFormats()
    });
    const decodedText = await scanner.scanFile(file, false);
    return decodedText?.trim() || "";
  } catch (error) {
    return "";
  } finally {
    if (scanner) {
      try {
        await scanner.clear();
      } catch (error) {
        // Some versions only need clear() after live camera scanning.
      }
    }
  }
}

function getHtml5BarcodeFormats() {
  if (!window.Html5QrcodeSupportedFormats) return undefined;

  return [
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.QR_CODE
  ].filter((format) => typeof format !== "undefined");
}

async function decodeWithQuagga(file) {
  if (!window.Quagga) return "";

  const src = await fileToDataUrl(file);
  const attempts = [
    { locate: true, size: 1280 },
    { locate: true, size: 960 },
    { locate: false, size: 1280 },
    { locate: false, size: 720 }
  ];

  for (const attempt of attempts) {
    const result = await decodeQuaggaAttempt(src, attempt);
    if (result) return result;
  }

  return "";
}

function decodeQuaggaAttempt(src, attempt) {
  return new Promise((resolve) => {
    Quagga.decodeSingle(
      {
        src,
        numOfWorkers: 0,
        locate: attempt.locate,
        inputStream: {
          size: attempt.size,
          singleChannel: false
        },
        locator: {
          patchSize: "medium",
          halfSample: true
        },
        decoder: {
          readers: [
            "ean_reader",
            "ean_8_reader",
            "upc_reader",
            "upc_e_reader",
            "code_128_reader",
            "code_39_reader",
            "i2of5_reader"
          ],
          multiple: false
        }
      },
      (result) => {
        const code = result?.codeResult?.code?.trim();
        resolve(code || "");
      }
    );
  });
}

async function setupBarcodeDetector() {
  if (!("BarcodeDetector" in window)) {
    startScanButton.title = "Este navegador não oferece leitura automática. Use o campo manual.";
    setScanStatus("Toque em Ler código para abrir a câmera do celular.");
    return;
  }

  const preferredFormats = ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "qr_code"];
  let formats = preferredFormats;

  if (BarcodeDetector.getSupportedFormats) {
    const supportedFormats = await BarcodeDetector.getSupportedFormats();
    formats = preferredFormats.filter((format) => supportedFormats.includes(format));
  }

  if (!formats.length) {
    startScanButton.title = "Este navegador abre a câmera, mas não lê esses códigos automaticamente.";
    setScanStatus("A câmera abre, mas este navegador não lê código automaticamente.");
    return;
  }

  detector = new BarcodeDetector({ formats });
  setScanStatus("Toque em Ler código e fotografe o código de barras.");
}

async function decodeBarcodeFromImage(image) {
  const attempts = makeBarcodeCanvases(image);

  for (const canvas of attempts) {
    const codes = await detector.detect(canvas);
    const rawValue = codes[0]?.rawValue?.trim();
    if (rawValue) return rawValue;
  }

  return "";
}

function makeBarcodeCanvases(image) {
  const maxWidth = 1400;
  const scale = Math.min(1, maxWidth / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const base = document.createElement("canvas");
  base.width = width;
  base.height = height;
  base.getContext("2d").drawImage(image, 0, 0, width, height);

  const crops = [
    { x: 0, y: 0, w: width, h: height },
    { x: 0, y: height * 0.2, w: width, h: height * 0.6 },
    { x: width * 0.08, y: height * 0.25, w: width * 0.84, h: height * 0.5 },
    { x: width * 0.15, y: height * 0.15, w: width * 0.7, h: height * 0.7 }
  ];

  const canvases = [];
  crops.forEach((crop) => {
    const cropped = cropCanvas(base, crop);
    canvases.push(cropped, enhanceContrast(cropped));
    canvases.push(rotateCanvas(cropped, 90), rotateCanvas(cropped, 270));
  });

  return canvases;
}

function cropCanvas(source, crop) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.w));
  canvas.height = Math.max(1, Math.round(crop.h));
  canvas.getContext("2d").drawImage(
    source,
    Math.round(crop.x),
    Math.round(crop.y),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvas;
}

function rotateCanvas(source, degrees) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const radians = degrees * Math.PI / 180;
  const sideways = degrees === 90 || degrees === 270;
  canvas.width = sideways ? source.height : source.width;
  canvas.height = sideways ? source.width : source.height;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function enhanceContrast(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = gray > 145 ? 255 : 0;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setScanStatus(message) {
  scanStatus.textContent = message;
}

function showFormStatus(message) {
  formStatus.textContent = message;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    formStatus.textContent = "";
  }, 3200);
}
