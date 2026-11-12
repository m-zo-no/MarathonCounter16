"use strict";

// ============================================================
// 画面要素
// ============================================================

const elementIds = [
  "roleScreen",
  "connectionHeader",
  "setupScreen",
  "counterScreen",

  "roomKey",
  "launchButton",
  "roleError",

  "connectionInfo",
  "connectionStatus",
  "notice",
  "leaveButton",

  "studentCount",
  "prepareButton",

  "startButton",
  "resetButton",
  "setupButton",
  "timer",

  "counterHelp",
  "studentGrid",

  "editDialog",
  "editForm",
  "editName",
  "editTarget",
  "editPaceMinutes",
  "editPaceSeconds",
  "editReset",
  "editError",
  "retireButton",
  "cancelEditButton",
  "saveEditButton",
];

const ui = Object.fromEntries(
  elementIds.map((id) => [id, document.getElementById(id)])
);

const SESSION_KEY = "lapCounterWebSession";
const ADMIN_SESSION_KEY = "lapCounterWebAdminSession";

const POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 4000;

const ROOM_NOT_FOUND_MESSAGE =
  "接続キーに対応する部屋がありません。";

let session = null;
let state = null;

let connected = false;
let polling = false;
let busy = false;

let elapsedBase = 0;
let elapsedBaseAt = performance.now();

let renderedVersion = null;
let renderedScreen = null;

let editingStudentId = null;
let editingRunId = null;
let editingRevision = null;

let audioContext = null;

// ============================================================
// プルダウン
// ============================================================

function fillNumberSelect(select, min, max, selectedValue) {
  const fragment = document.createDocumentFragment();

  for (let value = min; value <= max; value += 1) {
    const option = document.createElement("option");

    option.value = String(value);
    option.textContent = String(value);

    fragment.append(option);
  }

  select.replaceChildren(fragment);
  select.value = String(selectedValue);
}

function initializeSelects() {
  fillNumberSelect(ui.studentCount, 1, 40, 20);
  fillNumberSelect(ui.editTarget, 1, 10, 1);
  fillNumberSelect(ui.editPaceMinutes, 0, 99, 0);
  fillNumberSelect(ui.editPaceSeconds, 0, 59, 0);
}

function readSelectedInteger(select, min, max, errorMessage) {
  if (select.value === "") {
    throw new Error(errorMessage);
  }

  const value = Number(select.value);

  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(errorMessage);
  }

  return value;
}

function readStudentCount() {
  return readSelectedInteger(
    ui.studentCount,
    1,
    40,
    "人数は1〜40名から選択してください。"
  );
}

function readSelectedTarget() {
  return readSelectedInteger(
    ui.editTarget,
    1,
    10,
    "周数は1〜10から選択してください。"
  );
}

function readSelectedPace() {
  const minutes = readSelectedInteger(
    ui.editPaceMinutes,
    0,
    99,
    "目標ペースの分を選択してください。"
  );

  const seconds = readSelectedInteger(
    ui.editPaceSeconds,
    0,
    59,
    "目標ペースの秒を選択してください。"
  );

  const total = minutes * 60 + seconds;

  if (total <= 0) {
    throw new Error(
      "目標ペースは0秒より大きい値を選択してください。"
    );
  }

  return total;
}

// ============================================================
// B用の効果音
// ============================================================

function getAudioContext() {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
  }

  return audioContext;
}

function addTone(context, options) {
  const {
    frequency,
    startAt,
    duration,
    type = "sine",
    volume = 0.16,
    endFrequency = frequency,
  } = options;

  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = type;

  oscillator.frequency.setValueAtTime(
    frequency,
    startAt
  );

  oscillator.frequency.exponentialRampToValueAtTime(
    Math.max(1, endFrequency),
    startAt + duration
  );

  gain.gain.setValueAtTime(0.0001, startAt);

  gain.gain.exponentialRampToValueAtTime(
    volume,
    startAt + 0.01
  );

  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startAt + duration
  );

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.01);
}

function playBEffect(delta) {
  try {
    const context = getAudioContext();

    if (!context) {
      return;
    }

    // タップ操作の中で再開を依頼する。
    // 音声の再生に失敗しても記録操作は妨げない。
    if (context.state === "suspended") {
      context.resume().catch(() => {});
    }

    const now = context.currentTime + 0.01;

    if (delta === -1) {
      // 「ピロン」風：高い2音
      addTone(context, {
        frequency: 880,
        endFrequency: 980,
        startAt: now,
        duration: 0.10,
        type: "sine",
        volume: 0.14,
      });

      addTone(context, {
        frequency: 1320,
        endFrequency: 1500,
        startAt: now + 0.09,
        duration: 0.18,
        type: "sine",
        volume: 0.14,
      });
    } else if (delta === 1) {
      // 「ブブッ」風：低い2音
      addTone(context, {
        frequency: 170,
        endFrequency: 125,
        startAt: now,
        duration: 0.10,
        type: "square",
        volume: 0.07,
      });

      addTone(context, {
        frequency: 150,
        endFrequency: 105,
        startAt: now + 0.13,
        duration: 0.13,
        type: "square",
        volume: 0.07,
      });
    }
  } catch {
    // 音声に対応していない場合も、画面操作は続行する。
  }
}

// ============================================================
// 接続情報の保存
// ============================================================

function isValidSession(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (!["A", "B", "C"].includes(value.role)) {
    return false;
  }

  if (
    typeof value.key !== "string" ||
    value.key.length === 0
  ) {
    return false;
  }

  if (
    value.role === "A" &&
    (
      typeof value.adminToken !== "string" ||
      value.adminToken.length === 0
    )
  ) {
    return false;
  }

  return true;
}

function readSavedSession(storageKey) {
  const raw = localStorage.getItem(storageKey);

  if (!raw) {
    return null;
  }

  let value;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("保存された接続情報を読み取れません。");
  }

  if (!isValidSession(value)) {
    throw new Error("保存された接続情報が不正です。");
  }

  return value;
}

function saveSession(value) {
  const serialized = JSON.stringify(value);

  if (value.role === "A") {
    localStorage.setItem(ADMIN_SESSION_KEY, serialized);
  }

  localStorage.setItem(SESSION_KEY, serialized);
}

function migrateOldSession() {
  const oldValue = sessionStorage.getItem(SESSION_KEY);

  if (!oldValue || localStorage.getItem(SESSION_KEY)) {
    return;
  }

  try {
    const value = JSON.parse(oldValue);

    if (isValidSession(value)) {
      saveSession(value);
    }
  } catch {
    // 古い情報が読み取れない場合は移行しない。
  }
}

// ============================================================
// 画面の基本操作
// ============================================================

function selectedRole() {
  const selected = document.querySelector(
    'input[name="role"]:checked'
  );

  return selected ? selected.value : "A";
}

function updateRoleInputs() {
  const keyRequired = selectedRole() !== "A";

  ui.roomKey.disabled = !keyRequired;

  if (keyRequired) {
    ui.roomKey.focus();
  }
}

function showRoleScreen() {
  ui.roleScreen.classList.remove("hidden");
  ui.connectionHeader.classList.add("hidden");
  ui.setupScreen.classList.add("hidden");
  ui.counterScreen.classList.add("hidden");

  ui.notice.textContent = "";
}

function showAppScreen(screen) {
  ui.roleScreen.classList.add("hidden");
  ui.connectionHeader.classList.remove("hidden");

  ui.setupScreen.classList.toggle(
    "hidden",
    screen !== "setup"
  );

  ui.counterScreen.classList.toggle(
    "hidden",
    screen !== "counter"
  );
}

function resetRendering() {
  state = null;
  connected = false;

  elapsedBase = 0;
  elapsedBaseAt = performance.now();

  renderedVersion = null;
  renderedScreen = null;
}

// ============================================================
// 時間とペース
// ============================================================

function formatTime(seconds) {
  const value = Number(seconds);

  const whole = Math.max(
    0,
    Math.floor(Number.isFinite(value) ? value : 0)
  );

  const minutes = Math.floor(whole / 60);
  const remainingSeconds = whole % 60;

  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(remainingSeconds).padStart(2, "0")
  );
}

function formatDifference(seconds) {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value === 0) {
    return "±0";
  }

  if (value > 0) {
    return `＋${value}`;
  }

  return `−${Math.abs(value)}`;
}

function differenceClass(seconds) {
  const value = Number(seconds);

  if (value > 3) {
    return "difference-red";
  }

  if (value < -3) {
    return "difference-blue";
  }

  return "difference-green";
}

function currentElapsed() {
  if (!state) {
    return 0;
  }

  if (state.running && connected) {
    return (
      elapsedBase +
      (performance.now() - elapsedBaseAt) / 1000
    );
  }

  return elapsedBase;
}

function setOffline() {
  if (connected) {
    elapsedBase = currentElapsed();
    elapsedBaseAt = performance.now();
  }

  connected = false;

  updateConnectionDisplay();
  updateControls();
}

// ============================================================
// サーバー通信
// ============================================================

async function api(path, payload = null, activeSession = session) {
  const headers = {};

  if (activeSession) {
    headers["X-Room-Key"] = activeSession.key;
    headers["X-Role"] = activeSession.role;

    if (activeSession.role === "A") {
      headers["X-Admin-Token"] = activeSession.adminToken;
    }
  }

  const options = {
    method: payload === null ? "GET" : "POST",
    headers,
    cache: "no-store",
  };

  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    options.signal = controller.signal;

    const response = await fetch(path, options);
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(
        result.error || "通信に失敗しました。"
      );
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollState() {
  if (!session || polling) {
    return;
  }

  const activeSession = session;
  polling = true;

  try {
    const result = await api(
      "/api/state",
      null,
      activeSession
    );

    if (session === activeSession) {
      applyState(result.state);
    }
  } catch {
    if (session === activeSession) {
      setOffline();
    }
  } finally {
    polling = false;
  }
}

async function performAction(path, payload = {}) {
  if (!session || !connected || busy) {
    return false;
  }

  const activeSession = session;

  busy = true;
  updateControls();

  try {
    const result = await api(
      path,
      payload,
      activeSession
    );

    if (session !== activeSession) {
      return false;
    }

    ui.notice.textContent = "";
    applyState(result.state);

    return true;
  } catch (error) {
    if (session === activeSession) {
      ui.notice.textContent =
        (error.message || "通信に失敗しました。") +
        " 操作が反映された可能性もあるため、" +
        "最新画面を確認してください。";

      await pollState();
    }

    return false;
  } finally {
    busy = false;
    updateControls();
  }
}

// ============================================================
// 起動・退出
// ============================================================

document
  .querySelectorAll('input[name="role"]')
  .forEach((input) => {
    input.addEventListener("change", updateRoleInputs);
  });

ui.launchButton.addEventListener("click", async () => {
  const role = selectedRole();

  ui.roleError.textContent = "";
  ui.launchButton.disabled = true;

  try {
    let candidate;
    let result;

    if (role === "A") {
      candidate = readSavedSession(ADMIN_SESSION_KEY);

      if (candidate) {
        if (candidate.role !== "A") {
          throw new Error("Aの保存情報が不正です。");
        }

        try {
          result = await api(
            "/api/state",
            null,
            candidate
          );
        } catch (error) {
          if (error.message !== ROOM_NOT_FOUND_MESSAGE) {
            throw error;
          }

          const createNew = confirm(
            "以前の部屋が見つかりません。\n\n" +
            "新しい部屋を作成しますか？\n\n" +
            "新しい部屋に以前の記録は引き継がれません。\n" +
            "B・Cも新しい接続キーで接続し直してください。"
          );

          if (!createNew) {
            throw error;
          }

          result = await api(
            "/api/create",
            {},
            null
          );

          candidate = {
            role: "A",
            key: result.key,
            adminToken: result.admin_token,
          };
        }
      } else {
        result = await api(
          "/api/create",
          {},
          null
        );

        candidate = {
          role: "A",
          key: result.key,
          adminToken: result.admin_token,
        };
      }
    } else {
      const key = ui.roomKey.value.trim().toUpperCase();

      if (!key) {
        throw new Error("接続キーを入力してください。");
      }

      candidate = {
        role,
        key,
      };

      result = await api(
        "/api/state",
        null,
        candidate
      );
    }

    saveSession(candidate);

    resetRendering();
    session = candidate;
    applyState(result.state);
  } catch (error) {
    ui.roleError.textContent =
      error.message || "接続できませんでした。";
  } finally {
    ui.launchButton.disabled = false;
  }
});

ui.leaveButton.addEventListener("click", () => {
  if (!confirm("役割選択画面に戻りますか？")) {
    return;
  }

  // Aの管理情報は次回の復帰のために残す。
  localStorage.removeItem(SESSION_KEY);

  session = null;
  resetRendering();

  if (ui.editDialog.open) {
    ui.editDialog.close();
  }

  ui.roleError.textContent = "";
  showRoleScreen();
});

async function restoreSession() {
  let candidate;

  try {
    migrateOldSession();
    candidate = readSavedSession(SESSION_KEY);
  } catch (error) {
    showRoleScreen();
    ui.roleError.textContent = error.message;
    return;
  }

  if (!candidate) {
    showRoleScreen();
    return;
  }

  ui.launchButton.disabled = true;

  try {
    const result = await api(
      "/api/state",
      null,
      candidate
    );

    saveSession(candidate);

    resetRendering();
    session = candidate;
    applyState(result.state);
  } catch {
    showRoleScreen();

    if (candidate.role === "B" || candidate.role === "C") {
      const radio = document.querySelector(
        `input[name="role"][value="${candidate.role}"]`
      );

      if (radio) {
        radio.checked = true;
      }

      ui.roomKey.value = candidate.key;
      updateRoleInputs();
    }

    ui.roleError.textContent =
      "前回の接続を復元できませんでした。" +
      "サーバーを確認してから起動してください。";
  } finally {
    ui.launchButton.disabled = false;
  }
}

// ============================================================
// サーバーの状態を画面に反映
// ============================================================

function applyState(newState) {
  if (!session || !newState) {
    return;
  }

  if (
    state &&
    newState.version < state.version
  ) {
    return;
  }

  const oldRunId = state?.run_id;

  state = newState;

  if (
    oldRunId &&
    oldRunId !== newState.run_id &&
    ui.editDialog.open
  ) {
    ui.editDialog.close();

    ui.notice.textContent =
      "走行が切り替わったため、編集画面を閉じました。";
  }

  connected = true;

  elapsedBase = Number(newState.elapsed) || 0;
  elapsedBaseAt = performance.now();

  showAppScreen(newState.screen);
  updateConnectionDisplay();

  if (
    renderedVersion !== newState.version ||
    renderedScreen !== newState.screen
  ) {
    if (newState.screen === "setup") {
      renderSetup();
    } else {
      renderCounter();
    }

    renderedVersion = newState.version;
    renderedScreen = newState.screen;
  }

  updateControls();
}

function updateConnectionDisplay() {
  if (!session) {
    return;
  }

  const roleNames = {
    A: "親機",
    B: "ゴール専用",
    C: "閲覧専用",
  };

  ui.connectionInfo.textContent =
    `${session.role}：${roleNames[session.role]}` +
    `　接続キー：${session.key}`;

  let text = "";
  let online = false;

  if (!connected) {
    text =
      "サーバーに接続できません。" +
      "再接続を試みています。";
  } else if (session.role === "A") {
    online = Boolean(state?.b_connected);

    text = online
      ? "B接続中 — Aは通常の周回を記録できます。"
      : "B未接続 — ゴール記録前にBを接続してください。";
  } else if (session.role === "B") {
    online = true;
    text = "サーバーと同期中 — 最後の−1を操作できます。";
  } else {
    online = true;
    text = "サーバーと同期中 — 閲覧専用です。";
  }

  ui.connectionStatus.textContent = text;

  ui.connectionStatus.className =
    "connection-status " +
    (online ? "status-online" : "status-offline");
}

function updateControls() {
  if (!session || !state) {
    return;
  }

  const isAdmin = session.role === "A";

  const adminDisabled =
    !isAdmin ||
    !connected ||
    busy;

  ui.studentCount.disabled = adminDisabled;
  ui.prepareButton.disabled = adminDisabled;

  ui.setupButton.disabled = adminDisabled;
  ui.resetButton.disabled = adminDisabled;

  ui.startButton.disabled =
    adminDisabled ||
    state.running;

  ui.startButton.textContent = state.running
    ? "計測中"
    : "▶ スタート";

  ui.startButton.classList.toggle(
    "running",
    state.running
  );

  ui.saveEditButton.disabled = adminDisabled;

  const student = findStudent(editingStudentId);

  ui.retireButton.disabled =
    adminDisabled ||
    !student ||
    student.finish_time !== null;

  if (state.screen === "counter") {
    updateRowPermissions();
  }
}

// ============================================================
// 人数設定
// ============================================================

function renderSetup() {
  if (
    session.role !== "A" ||
    document.activeElement !== ui.studentCount
  ) {
    ui.studentCount.value = String(state.draft_count);
  }
}

ui.prepareButton.addEventListener("click", () => {
  try {
    const count = readStudentCount();

    performAction("/api/prepare", {
      count,
    });
  } catch (error) {
    ui.notice.textContent = error.message;
  }
});

// ============================================================
// 周回記録画面
// ============================================================

function makeButton(className, text) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = className;
  button.textContent = text;

  return button;
}

function makeLapCell(student, index, laps) {
  const cell = document.createElement("div");

  cell.className = "lap-cell";

  if (index >= laps.length) {
    return cell;
  }

  const current = Number(laps[index]) || 0;

  const previous = index === 0
    ? 0
    : Number(laps[index - 1]) || 0;

  const lapTime = Math.floor(
    Math.max(0, current - previous)
  );

  const paceValue = Number(student.target_pace);

  const pace = Math.max(
    0,
    Math.floor(
      Number.isFinite(paceValue) ? paceValue : 0
    )
  );

  const difference = lapTime - pace;

  // 差の色を数字だけでなくセル全体に付ける。
  cell.classList.add(differenceClass(difference));

  const differenceElement = document.createElement("span");

  differenceElement.className = "lap-difference";

  differenceElement.textContent =
    formatDifference(difference);

  const timeElement = document.createElement("span");

  timeElement.className = "lap-time";
  timeElement.textContent = formatTime(lapTime);

  cell.title =
    `${index + 1}周目：${formatTime(lapTime)}` +
    `／目標との差：${formatDifference(difference)}秒`;

  cell.append(differenceElement, timeElement);

  return cell;
}

function renderCounter() {
  if (session.role === "A") {
    ui.counterHelp.textContent =
      "A：名前または目標ペースを押して設定。" +
      "計測中は−1で周回、＋1で直前の周回を取り消します。";
  } else if (session.role === "B") {
    ui.counterHelp.textContent =
      "B：残り1周のランナーの−1でゴールを記録します。" +
      "＋1は音のみで、記録は変更しません。";
  } else {
    ui.counterHelp.textContent =
      "C：閲覧専用です。記録は自動で更新されます。";
  }

  ui.studentGrid.replaceChildren();

  for (const student of state.students) {
    const row = document.createElement("div");

    row.className = "student-row";
    row.dataset.studentId = String(student.id);

    // 名前
    const nameButton = makeButton(
      "name-cell",
      student.name
    );

    nameButton.title =
      `${student.name}：設定を開く`;

    if (student.retired) {
      nameButton.classList.add("retired-name");
    }

    nameButton.addEventListener("click", () => {
      openEditDialog(student.id);
    });

    // 目標ペース
    const paceButton = makeButton(
      "pace-cell",
      formatTime(student.target_pace)
    );

    paceButton.title =
      `目標ペース：${formatTime(student.target_pace)}` +
      "／設定を開く";

    if (student.retired) {
      paceButton.classList.add("retired-pace");
    }

    paceButton.addEventListener("click", () => {
      openEditDialog(student.id);
    });

    // 周回欄
    const lapCells = document.createElement("div");

    lapCells.className = "lap-cells";

    if (student.retired) {
      const retiredCell = document.createElement("div");

      retiredCell.className = "retired-cell";
      retiredCell.style.gridColumn = "1 / -1";
      retiredCell.textContent = "リタイヤ";

      lapCells.append(retiredCell);
    } else {
      const laps = Array.isArray(student.laps)
        ? student.laps
        : [];

      for (let index = 0; index < student.target; index += 1) {
        lapCells.append(
          makeLapCell(student, index, laps)
        );
      }

      if (student.target < 10) {
        const unused = document.createElement("div");

        unused.className = "lap-unused";
        unused.style.gridColumn =
          `span ${10 - student.target}`;

        lapCells.append(unused);
      }
    }

    // 操作欄または合計タイム
    let actionArea;

    const finished =
      student.finish_time !== null &&
      student.remaining === 0;

    if (finished) {
      actionArea = document.createElement("div");

      actionArea.className = "finish-cell";
      actionArea.textContent =
        formatTime(student.finish_time);

      actionArea.title =
        `合計：${formatTime(student.finish_time)}`;
    } else if (session.role === "C") {
      actionArea = document.createElement("div");

      actionArea.className = "viewer-cell";

      actionArea.textContent = student.retired
        ? "休止中"
        : `残り${student.remaining}周`;
    } else {
      actionArea = document.createElement("div");
      actionArea.className = "action-cells";

      const minusButton = makeButton(
        "minus-cell",
        "−1"
      );

      minusButton.dataset.delta = "-1";

      if (
        session.role === "B" &&
        student.remaining === 1 &&
        !student.retired
      ) {
        minusButton.classList.add("finish-ready");
      }

      minusButton.addEventListener("click", () => {
        changeRemaining(student.id, -1);
      });

      const plusButton = makeButton(
        "plus-cell",
        "＋1"
      );

      plusButton.dataset.delta = "1";

      if (session.role === "B") {
        plusButton.title = "音のみ再生します。記録は変更しません。";
        plusButton.setAttribute(
          "aria-label",
          `${student.name}：＋1の音を再生。記録は変更しません`
        );
      }

      plusButton.addEventListener("click", () => {
        changeRemaining(student.id, 1);
      });

      actionArea.append(minusButton, plusButton);
    }

    row.append(
      nameButton,
      paceButton,
      lapCells,
      actionArea
    );

    ui.studentGrid.append(row);
  }

  updateRowPermissions();
}

function findStudent(studentId) {
  return state?.students.find(
    (student) => student.id === studentId
  );
}

function canChange(student, delta) {
  if (
    !session ||
    !state ||
    !connected ||
    busy ||
    state.screen !== "counter" ||
    !state.running ||
    student.retired ||
    student.finish_time !== null
  ) {
    return false;
  }

  if (session.role === "A") {
    if (delta === -1) {
      return student.remaining >= 2;
    }

    if (delta === 1) {
      return (
        Array.isArray(student.laps) &&
        student.laps.length > 0
      );
    }

    return false;
  }

  if (session.role === "B") {
    return (
      delta === -1 &&
      student.remaining === 1
    );
  }

  return false;
}

function canPlayBPlus(student) {
  return Boolean(
    session &&
    session.role === "B" &&
    state &&
    state.screen === "counter" &&
    state.running &&
    connected &&
    !busy &&
    student &&
    !student.retired &&
    student.finish_time === null
  );
}

function updateRowPermissions() {
  for (const row of ui.studentGrid.children) {
    const studentId = Number(row.dataset.studentId);
    const student = findStudent(studentId);

    if (!student) {
      continue;
    }

    const editable =
      session.role === "A" &&
      connected &&
      !busy;

    const nameButton = row.querySelector(".name-cell");
    const paceButton = row.querySelector(".pace-cell");

    if (nameButton) {
      nameButton.disabled = !editable;
    }

    if (paceButton) {
      paceButton.disabled = !editable;
    }

    for (const button of row.querySelectorAll("[data-delta]")) {
      const delta = Number(button.dataset.delta);

      if (session.role === "B" && delta === 1) {
        // Bの＋1は音だけ鳴らす。
        button.disabled = !canPlayBPlus(student);
      } else {
        button.disabled = !canChange(student, delta);
      }
    }
  }
}

function makeRequestId() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

async function changeRemaining(studentId, delta) {
  const student = findStudent(studentId);

  if (!student) {
    return;
  }

  if (session?.role === "B" && delta === 1) {
    if (canPlayBPlus(student)) {
      playBEffect(1);
    }

    // Bには周回を戻す権限を与えない。
    return;
  }

  if (!canChange(student, delta)) {
    return;
  }

  // 音はタップ時に鳴る。サーバーへの記録成功を示す音ではない。
  if (session.role === "B" && delta === -1) {
    playBEffect(-1);
  }

  const payload = {
    student_id: student.id,
    revision: student.revision,
    run_id: state.run_id,
  };

  if (session.role === "B") {
    payload.request_id = makeRequestId();

    await performAction("/api/finish", payload);
  } else {
    payload.delta = delta;

    await performAction("/api/change", payload);
  }
}

// ============================================================
// ランナー設定
// ============================================================

function openEditDialog(studentId) {
  if (
    !session ||
    session.role !== "A" ||
    !connected ||
    busy ||
    !state ||
    state.screen !== "counter"
  ) {
    return;
  }

  const student = findStudent(studentId);

  if (!student) {
    return;
  }

  editingStudentId = student.id;
  editingRunId = state.run_id;
  editingRevision = student.revision;

  ui.editName.value = student.name;
  ui.editTarget.value = String(student.target);

  const paceValue = Number(student.target_pace);

  const targetPace = Math.max(
    0,
    Math.floor(
      Number.isFinite(paceValue) ? paceValue : 0
    )
  );

  ui.editPaceMinutes.value = String(
    Math.floor(targetPace / 60)
  );

  ui.editPaceSeconds.value = String(
    targetPace % 60
  );

  ui.editReset.checked = false;
  ui.editError.textContent = "";

  ui.retireButton.textContent = student.retired
    ? "リタイヤを解除"
    : "リタイヤにする";

  ui.retireButton.disabled =
    student.finish_time !== null;

  ui.editDialog.showModal();
}

ui.cancelEditButton.addEventListener("click", () => {
  ui.editDialog.close();
});

ui.editForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (
    !state ||
    editingStudentId === null ||
    editingRunId !== state.run_id
  ) {
    ui.editError.textContent =
      "走行が切り替わりました。画面を開き直してください。";

    return;
  }

  try {
    const name = ui.editName.value.trim();
    const target = readSelectedTarget();
    const targetPace = readSelectedPace();

    if (!name || name.length > 100) {
      throw new Error(
        "名前は1〜100文字で入力してください。"
      );
    }

    const success = await performAction("/api/edit", {
      student_id: editingStudentId,
      run_id: editingRunId,
      revision: editingRevision,
      name,
      target,
      target_pace: targetPace,
      reset: ui.editReset.checked,
    });

    if (success) {
      ui.editDialog.close();
    } else {
      ui.editError.textContent =
        "保存できませんでした。" +
        "画面を閉じて最新状態を確認してください。";
    }
  } catch (error) {
    ui.editError.textContent = error.message;
  }
});

ui.retireButton.addEventListener("click", async () => {
  const student = findStudent(editingStudentId);

  if (
    !student ||
    !state ||
    editingRunId !== state.run_id
  ) {
    ui.editError.textContent =
      "最新状態を確認してから操作してください。";

    return;
  }

  const nextRetired = !student.retired;

  const message = nextRetired
    ? "このランナーをリタイヤにしますか？"
    : "このランナーのリタイヤを解除しますか？";

  if (!confirm(message)) {
    return;
  }

  const success = await performAction("/api/retire", {
    student_id: editingStudentId,
    run_id: editingRunId,
    revision: editingRevision,
    retired: nextRetired,
  });

  if (success) {
    ui.editDialog.close();
  } else {
    ui.editError.textContent =
      "変更できませんでした。" +
      "画面を閉じて最新状態を確認してください。";
  }
});

ui.editDialog.addEventListener("close", () => {
  editingStudentId = null;
  editingRunId = null;
  editingRevision = null;

  ui.editError.textContent = "";
});

// ============================================================
// スタート・リセット・人数設定
// ============================================================

ui.startButton.addEventListener("click", () => {
  if (!state) {
    return;
  }

  performAction("/api/start", {
    run_id: state.run_id,
  });
});

ui.resetButton.addEventListener("click", () => {
  if (!state) {
    return;
  }

  const confirmed = confirm(
    "全員の計測記録を初期化しますか？\n" +
    "名前・周数・目標ペースは残ります。"
  );

  if (!confirmed) {
    return;
  }

  performAction("/api/reset", {
    run_id: state.run_id,
  });
});

ui.setupButton.addEventListener("click", () => {
  if (!state) {
    return;
  }

  const confirmed = confirm(
    "人数設定に戻りますか？\n" +
    "再び記録画面へ進むと計測記録は初期化されます。"
  );

  if (!confirmed) {
    return;
  }

  performAction("/api/setup", {
    run_id: state.run_id,
  });
});

// ============================================================
// タイマー・定期更新
// ============================================================

function updateTimer() {
  ui.timer.textContent = formatTime(currentElapsed());

  requestAnimationFrame(updateTimer);
}

initializeSelects();

updateRoleInputs();
showRoleScreen();

restoreSession();

setInterval(pollState, POLL_INTERVAL_MS);
requestAnimationFrame(updateTimer);
