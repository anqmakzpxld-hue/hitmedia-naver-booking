// main.js
// 히트미디어 네이버 예약 알림 프로그램 (POS용, Windows)
//
// 동작 방식:
// 1. 최초 실행 시 매장명을 입력받아 로컬에 저장한다 (다음부터는 자동으로 건너뜀).
// 2. 네이버 예약 파트너센터 화면을 그대로 창에 띄운다 (승인/취소/관리는 네이버 화면 그대로 사용).
// 3. 그 창(webContents) 안에서 직접 fetch를 실행해 예약 API를 주기적으로 조회한다.
//    (쿠키를 별도로 복사해서 보내는 방식은 인증이 자주 깨져서, 이 방식으로 변경함)
// 4. 새 예약이 생기면 카톡 스타일 팝업 + 알림음으로 알려준다.
// 5. 새 예약 데이터를 전배연 ERP 서버로도 전송한다.
// 6. Windows 로그인 시 자동으로 실행되도록 등록한다 (POS가 켜지면 함께 켜짐).

const { app, BrowserWindow, session, screen, ipcMain, shell, dialog } = require("electron");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const NAVER_BOOKING_URL = "https://partner.booking.naver.com/booking-list-view";
const API_BASE = "https://partner.booking.naver.com/api/bookings";

const ERP_API_URL = process.env.ERP_API_URL || "https://jbnyeon-erp-six.vercel.app";
const ERP_API_KEY = process.env.ERP_API_KEY || "";

const POLL_INTERVAL_MS = 2 * 60 * 1000;

const CONFIG_FILE = path.join(app.getPath("userData"), "store_config.json");
const OWNER_PASSWORD_FILE = path.join(app.getPath("userData"), "owner_password.json");
const SEEN_IDS_FILE = path.join(app.getPath("userData"), "seen_booking_ids.json");

const STATUS_LABELS = {
  RC00: "신청",
  RC01: "취소",
  RC02: "거절",
  RC03: "확정",
  RC04: "완료",
  RC05: "노쇼",
};

function loadStoreConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveStoreConfig(storeName) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ storeName }), "utf-8");
}

// 사장님 전용 메뉴 비밀번호는 설치 시 로그인 화면과 완전히 별개로,
// "사장님 전용" 메뉴를 처음 클릭했을 때 그 자리에서 설정한다.
function loadOwnerPassword() {
  try {
    const data = JSON.parse(fs.readFileSync(OWNER_PASSWORD_FILE, "utf-8"));
    return data.password || null;
  } catch {
    return null;
  }
}

function saveOwnerPassword(password) {
  fs.writeFileSync(OWNER_PASSWORD_FILE, JSON.stringify({ password }), "utf-8");
}

function loadSeenIds() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_IDS_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

function saveSeenIds(seenIds) {
  fs.writeFileSync(SEEN_IDS_FILE, JSON.stringify([...seenIds]), "utf-8");
}

function buildBookingsUrl() {
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const fmt = (d) => d.toISOString().slice(0, 19) + "." + String(d.getMilliseconds()).padStart(3, "0") + "Z";

  const params = new URLSearchParams({
    bizItemTypes: "STANDARD",
    dateDropdownType: "MONTH",
    dateFilter: "USEDATE",
    endDateTime: fmt(end),
    maxDays: "31",
    orderBy: "",
    orderByStartDate: "ASC",
    paymentStatusCodes: "",
    searchValue: "",
    startDateTime: fmt(now),
    page: "0",
    size: "50",
  });
  return API_BASE + "?" + params.toString();
}

async function checkNewBookings(targetWebContents, seenIds, storeName) {
  try {
    const url = buildBookingsUrl();

    const script =
      "fetch(" + JSON.stringify(url) + ", { credentials: 'include' })" +
      ".then(r => r.json().then(data => ({ status: r.status, data })))" +
      ".catch(e => ({ status: 0, error: String(e) }))";

    const result = await targetWebContents.executeJavaScript(script);

    if (result.status !== 200) {
      console.error("[예약 확인 실패] status=" + result.status, result.error || JSON.stringify(result.data).slice(0, 300));
      return;
    }

    const data = result.data;
    const bookings = Array.isArray(data) ? data : (data && data.bookingList) || [];
    const newOnes = bookings.filter((b) => b.bookingId && !seenIds.has(String(b.bookingId)));

    for (const b of newOnes) {
      seenIds.add(String(b.bookingId));
      showNewBookingNotification(b);
      sendToErp(b, storeName);
    }
    if (newOnes.length > 0) saveSeenIds(seenIds);
    console.log("[디버그] 조회 성공, 예약 " + bookings.length + "건 (신규 " + newOnes.length + "건)");
  } catch (err) {
    console.error("[예약 확인 실패]", err.message);
  }
}

function showNewBookingNotification(booking) {
  shell.beep();

  const display = screen.getPrimaryDisplay();
  const areaSize = display.workAreaSize;
  const popupWidth = 340;
  const popupHeight = 100;
  const margin = 16;

  const popup = new BrowserWindow({
    width: popupWidth,
    height: popupHeight,
    x: areaSize.width - popupWidth - margin,
    y: areaSize.height - popupHeight - margin,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  popup.loadFile("popup.html");
  popup.setVisibleOnAllWorkspaces(true);

  popup.webContents.once("did-finish-load", () => {
    popup.webContents.send("booking-data", {
      name: booking.name || "고객",
      time: booking.startDate || "",
      headCount: booking.bookingCount,
      statusLabel: STATUS_LABELS[booking.bookingStatusCode] || booking.bookingStatusCode || "",
    });
  });
}

ipcMain.on("close-popup", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// 사장님 전용 메뉴 진입 시 사용하는 IPC
ipcMain.handle("owner-check-has-password", () => {
  return loadOwnerPassword() !== null;
});

ipcMain.handle("owner-set-password", (event, password) => {
  saveOwnerPassword(password);
  return true;
});

ipcMain.handle("owner-verify-password", (event, password) => {
  const saved = loadOwnerPassword();
  return saved !== null && saved === password;
});

// ---------------------------------------------------------------------------
// 출퇴근부 기능용 ERP API 중계 (렌더러의 fetch는 CORS에 막힐 수 있어
// 메인 프로세스에서 axios로 대신 호출한다)
// ---------------------------------------------------------------------------
function erpHeaders() {
  return {
    Authorization: "Bearer " + ERP_API_KEY,
    "Content-Type": "application/json",
  };
}

ipcMain.handle("erp-get-employees", async (event, storeName) => {
  try {
    const resp = await axios.get(ERP_API_URL + "/api/employees", {
      params: { store_name: storeName },
      headers: erpHeaders(),
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("erp-delete-employee", async (event, id) => {
  try {
    console.log("[디버그] 삭제 요청 시도, id:", id);
    const resp = await axios.delete(ERP_API_URL + "/api/employees?id=" + id, {
      headers: erpHeaders(),
    });
    console.log("[디버그] 삭제 성공:", resp.status);
    return { ok: true, data: resp.data };
  } catch (err) {
    console.error("[디버그] 삭제 실패 상세:", err.message);
    if (err.response) {
      console.error("[디버그] 응답 상태:", err.response.status, "내용:", JSON.stringify(err.response.data));
    }
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("erp-update-employee", async (event, payload) => {
  try {
    const resp = await axios.patch(ERP_API_URL + "/api/employees", payload, { headers: erpHeaders() });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.response ? JSON.stringify(err.response.data) : err.message };
  }
});

ipcMain.handle("save-contract-pdf", async (event, { fileName, title, bodyText }) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "근로계약서 저장",
      defaultPath: fileName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const html =
      "<html><head><meta charset='utf-8'><style>" +
      "body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;padding:40px;font-size:13px;line-height:1.9;color:#1C2030;}" +
      "h1{font-size:16px;margin-bottom:24px;}" +
      "pre{white-space:pre-wrap;font-family:inherit;font-size:13px;}" +
      "</style></head><body><h1>" + title + "</h1><pre>" + bodyText + "</pre></body></html>";

    const pdfWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await pdfWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdfBuffer = await pdfWindow.webContents.printToPDF({ printBackground: true });
    pdfWindow.close();

    fs.writeFileSync(filePath, pdfBuffer);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("erp-add-employee", async (event, payload) => {
  try {
    const resp = await axios.post(ERP_API_URL + "/api/employees", payload, { headers: erpHeaders() });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.response ? JSON.stringify(err.response.data) : err.message };
  }
});

ipcMain.handle("erp-get-attendance", async (event, storeName) => {
  try {
    const resp = await axios.get(ERP_API_URL + "/api/attendance-records", {
      params: { store_name: storeName },
      headers: erpHeaders(),
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("erp-add-leave", async (event, payload) => {
  try {
    const resp = await axios.post(ERP_API_URL + "/api/attendance-records", payload, { headers: erpHeaders() });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.response ? JSON.stringify(err.response.data) : err.message };
  }
});

ipcMain.handle("erp-delete-leave", async (event, id) => {
  try {
    const resp = await axios.delete(ERP_API_URL + "/api/attendance-records?id=" + id, {
      headers: erpHeaders(),
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("erp-add-contract", async (event, payload) => {
  try {
    const resp = await axios.post(ERP_API_URL + "/api/contracts", payload, { headers: erpHeaders() });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.response ? JSON.stringify(err.response.data) : err.message };
  }
});

ipcMain.handle("erp-get-contracts", async (event, storeName) => {
  try {
    const resp = await axios.get(ERP_API_URL + "/api/contracts", {
      params: { store_name: storeName },
      headers: erpHeaders(),
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function sendToErp(booking, storeName) {
  if (!ERP_API_KEY) {
    console.log("[디버그] ERP_API_KEY 없음, 전송 건너뜀");
    return;
  }
  try {
    const resp = await axios.post(
      ERP_API_URL + "/api/naver-bookings",
      {
        store_name: storeName,
        booking_id: booking.bookingId,
        customer_name: booking.name,
        phone: booking.phone,
        use_datetime: booking.startDate,
        status: booking.bookingStatusCode,
        raw: booking,
      },
      {
        headers: {
          Authorization: "Bearer " + ERP_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    console.log("[디버그] ERP 전송 성공: " + booking.name + " (status " + resp.status + ")");
  } catch (err) {
    console.error("[디버그] ERP 전송 실패: " + booking.name + " - " + err.message);
    if (err.response) {
      console.error("[디버그] ERP 응답 상태: " + err.response.status + ", 내용: " + JSON.stringify(err.response.data).slice(0, 300));
    }
  }
}

function createMainWindow(storeName) {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    title: "히트미디어 - " + storeName,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webviewTag: true,
    },
  });
  win.loadFile("app.html");

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("store-name", storeName);
  });

  return win;
}

function createSetupWindow() {
  return new Promise((resolve) => {
    const setupWin = new BrowserWindow({
      width: 440,
      height: 420,
      resizable: false,
      title: "히트미디어 - 초기 설정",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    setupWin.setMenuBarVisibility(false);
    setupWin.loadFile("setup.html");

    ipcMain.once("setup-complete", (event, storeName) => {
      saveStoreConfig(storeName);
      setupWin.close();
      resolve(storeName);
    });
  });
}

app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true });

  const config = loadStoreConfig();
  let storeName;
  if (!config) {
    storeName = await createSetupWindow();
  } else {
    storeName = config.storeName;
  }

  const mainWindow = createMainWindow(storeName);
  const seenIds = loadSeenIds();

  if (process.env.TEST_POPUP === "true") {
    setTimeout(() => {
      showNewBookingNotification({
        name: "테스트 고객",
        startDate: "2026-08-20",
        bookingCount: 2,
        bookingStatusCode: "RC00",
      });
    }, 3000);
  }

  // 예약 화면은 이제 메인 창이 아니라 사이드바 안의 <webview>이므로,
  // 그 webview가 실제로 붙는(attach) 시점에 해당 webContents를 확보해서
  // 그걸 대상으로 예약 조회를 실행해야 한다.
  mainWindow.webContents.on("did-attach-webview", (event, guestWebContents) => {
    console.log("[디버그] 네이버 예약 webview 연결됨, 20초 후 첫 조회 시작");
    setTimeout(() => {
      checkNewBookings(guestWebContents, seenIds, storeName).then(() => {
        setInterval(() => checkNewBookings(guestWebContents, seenIds, storeName), POLL_INTERVAL_MS);
      });
    }, 20000);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(storeName);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
