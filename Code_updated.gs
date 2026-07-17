// ============================================================
// ===== 寄件設定 =====
// 做法一（建議）：直接用 HR 的公司 Google 帳號登入並授權這個 Apps Script（執行 setupScheduleSheet
//   時用該帳號登入），之後信件自然會用這個帳號寄出，SENDER_EMAIL 可以留空不用改。
// 做法二：若實際執行 Apps Script 的帳號跟 HR 信箱不同，但已經在該帳號的 Gmail 設定裡
//   把 HR 信箱加為「已驗證的別名」（Gmail 設定 → 帳戶和匯入 → 以其他名義傳送），
//   把下面 SENDER_EMAIL 改成該別名，程式會改用這個身分寄出。
// ============================================================
var SENDER_EMAIL = '';              // 例如 'hr@yourcompany.com'，留空則用預設帳號寄出
var SENDER_NAME  = 'WT 招募團隊';    // 信件顯示的寄件人名稱

// Candidate Records 的排程日期：無論從面板或直接在試算表修改，皆記錄本次更新日期。
function todayDateString_() {
  var today = new Date();
  return today.getFullYear()+'/'+(today.getMonth()+1)+'/'+today.getDate();
}

function stampCandidateScheduledDate_(sheet, row, headers, changedColumn) {
  var changedField = headers[changedColumn - 1];
  var targetField = changedField === 'PI_date' ? 'Phone Interview Scheduled' :
    (changedField === 'Interview_date' ? 'Interview Scheduled' : '');
  if (!targetField) return;
  var targetColumn = headers.indexOf(targetField) + 1;
  if (targetColumn > 0) sheet.getRange(row, targetColumn).setValue(todayDateString_());
}

// 使用者直接在 Google 試算表編輯時也要同步留下排程更新日期。
function onEdit(e) {
  var range = e && e.range;
  if (!range) return;
  var sheet = range.getSheet();
  if (sheet.getName() !== 'Candidate Records' || range.getRow() < 2) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (var c = range.getColumn(); c < range.getColumn() + range.getNumColumns(); c++) {
    if (headers[c - 1] !== 'PI_date' && headers[c - 1] !== 'Interview_date') continue;
    for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) {
      stampCandidateScheduledDate_(sheet, r, headers, c);
    }
  }
}

function sendScheduleEmail_(to, subject, body, replyTo) {
  var options = { name: SENDER_NAME };
  if (replyTo) options.replyTo = replyTo;
  if (SENDER_EMAIL) {
    options.from = SENDER_EMAIL;
    GmailApp.sendEmail(to, subject, body, options); // 需要 SENDER_EMAIL 已是「已驗證的別名」
  } else {
    MailApp.sendEmail(to, subject, body, options);
  }
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ============================================================
  // ===== 面試時間協調：主管填寫頁面（回傳 HTML，非登入即可開啟）=====
  // ============================================================
  if (e.parameter.action === 'managerSchedulePage') {
    return renderManagerSchedulePage(ss, e.parameter.token);
  }

  // ===== 面試時間協調：主管送出表單後的感謝頁 =====
  if (e.parameter.action === 'submitManagerAvailability') {
    return submitManagerAvailability(ss, e.parameter.token, e.parameter.text);
  }

  // ===== 面試時間協調：Recruiter 建立邀約並自動寄信給（一位或多位）主管 =====
  if (e.parameter.action === 'createSchedule') {
    try {
      var schSheet = getOrCreateScheduleSheet(ss);
      var groupId = Utilities.getUuid();
      var nowStr = formatNowDateTime_();

      var managers = [];
      if (e.parameter.managers) {
        try { managers = JSON.parse(e.parameter.managers); } catch (parseErr) { managers = []; }
      }
      if ((!managers || !managers.length) && e.parameter.managerEmail) {
        managers = [{ name: e.parameter.managerName || '', email: e.parameter.managerEmail || '' }];
      }
      if (!managers || !managers.length) {
        return ContentService.createTextOutput(JSON.stringify({ error: '沒有指定任何主管' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      var scriptUrl = ScriptApp.getService().getUrl();
      var tokens = [];
      managers.forEach(function(mgr) {
        var token = Utilities.getUuid();
        tokens.push(token);
        schSheet.appendRow([
          token,                              // 1 Token
          e.parameter.resumeCode || '',       // 2 履歷代碼
          e.parameter.name || '',             // 3 Name
          e.parameter.bu || '',               // 4 BU
          e.parameter.jobFunction || '',      // 5 Job Function
          e.parameter.round || '',            // 6 Round
          mgr.name || '',                     // 7 ManagerName
          mgr.email || '',                    // 8 ManagerEmail
          '',                                 // 9 ManagerAvailability
          '',                                 // 10 ManagerFilledAt
          '',                                 // 11 CandidateAvailability
          '',                                 // 12 CandidateFilledAt
          '等待主管填寫',                      // 13 Status
          '',                                 // 14 FinalConfirmedTime
          e.parameter.createdBy || '',        // 15 CreatedBy（角色）
          nowStr,                             // 16 CreatedAt
          '',                                 // 17 Notes
          e.parameter.createdByName || '',    // 18 CreatedByName（實際建立的人）
          e.parameter.createdByEmail || '',   // 19 CreatedByEmail（主管回信會寄到這裡）
          groupId                             // 20 GroupId（同一批邀約共用，方便群組顯示與同步候選人時間）
        ]);

        // 自動寄信給主管；回覆地址設為實際建立這筆邀約的人，這樣多位 HR 也不會收錯信
        if (mgr.email) {
          var link = scriptUrl + '?action=managerSchedulePage&token=' + token;
          var subject = '【面試時間邀請】' + (e.parameter.name || '') + ' - ' + (e.parameter.jobFunction || '') +
            (e.parameter.round ? '（' + e.parameter.round + '）' : '');
          var body = (mgr.name ? mgr.name + ' 您好：' : '您好：') + '\n\n' +
            '我們正在為「' + (e.parameter.jobFunction || '') + '」職缺安排與 ' + (e.parameter.name || '') +
            ' 的' + (e.parameter.round || '面試') + '，\n' +
            '請點選以下連結，告訴我們您方便的時間（不需登入，直接填寫即可）：\n\n' +
            link + '\n\n' +
            '謝謝您的協助！' +
            (e.parameter.createdByName ? '\n\n' + e.parameter.createdByName : '');
          sendScheduleEmail_(mgr.email, subject, body, e.parameter.createdByEmail);
        }
      });

      return ContentService.createTextOutput(JSON.stringify({ success: true, groupId: groupId, tokens: tokens }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ===== 面試時間協調：Recruiter/BP 手動輸入候選人或 HR 方便時間（會同步套用到同一批邀約的所有主管）=====
  if (e.parameter.action === 'updateCandidateAvailability') {
    try {
      var schSheet2 = getOrCreateScheduleSheet(ss);
      var row2 = findScheduleRowByToken_(schSheet2, e.parameter.token);
      if (row2) {
        var groupId2 = schSheet2.getRange(row2, 20).getValue();
        var targetRows2 = groupId2 ? findScheduleRowsByGroupId_(schSheet2, groupId2) : [row2];
        var nowStr2 = formatNowDateTime_();
        targetRows2.forEach(function(r) {
          schSheet2.getRange(r, 11).setValue(e.parameter.text || ''); // CandidateAvailability
          schSheet2.getRange(r, 12).setValue(nowStr2);                // CandidateFilledAt
          updateScheduleStatus_(schSheet2, r);
        });
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ===== 面試時間協調：Recruiter/BP 直接在後台代填主管方便時間（不透過寄信連結）=====
  if (e.parameter.action === 'updateManagerAvailability') {
    try {
      var schSheet5 = getOrCreateScheduleSheet(ss);
      var row5 = findScheduleRowByToken_(schSheet5, e.parameter.token);
      if (row5) {
        schSheet5.getRange(row5, 9).setValue(e.parameter.text || '');  // ManagerAvailability
        schSheet5.getRange(row5, 10).setValue(formatNowDateTime_());   // ManagerFilledAt
        updateScheduleStatus_(schSheet5, row5);
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ===== 面試時間協調：Recruiter 人工確認最終面試時間 =====
  if (e.parameter.action === 'updateFinalTime') {
    try {
      var schSheet3 = getOrCreateScheduleSheet(ss);
      var row3 = findScheduleRowByToken_(schSheet3, e.parameter.token);
      if (row3) {
        schSheet3.getRange(row3, 14).setValue(e.parameter.text || ''); // FinalConfirmedTime
        schSheet3.getRange(row3, 13).setValue('已確認');                // Status
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ============================================================
  // ===== 以下為原有功能，維持不變 =====
  // ============================================================

  if (e.parameter.action === 'update') {
    try {
      var row = parseInt(e.parameter.row);
      var result = e.parameter.result;
      if (row && result) {
        var sheet = ss.getSheetByName('Candidate Records');
        var updHeaders = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
        var resultCol = updHeaders.indexOf('Result') + 1;
        if (resultCol > 0) {
          sheet.getRange(row, resultCol).setValue(result);
          var updCol = updHeaders.indexOf('Update_date') + 1;
          if (updCol > 0 && updCol !== resultCol) {
            var updToday = new Date();
            sheet.getRange(row, updCol).setValue(updToday.getFullYear()+'/'+(updToday.getMonth()+1)+'/'+updToday.getDate());
          }
        }
      }
    } catch(err) { Logger.log(err); }
    return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'updateMemo') {
    try {
      var hcRow = parseInt(e.parameter.row);
      var memo = e.parameter.memo;
      if (hcRow) {
        var hcSheet = ss.getSheetByName('Headcount Records');
        hcSheet.getRange(hcRow, 11).setValue(memo);
      }
    } catch(err) { Logger.log(err); }
    return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'editCell') {
    try {
      var sheetName = e.parameter.sheet;
      var row2b = parseInt(e.parameter.row);
      var col = parseInt(e.parameter.col);
      var value = e.parameter.value;
      var sh = ss.getSheetByName(sheetName);
      sh.getRange(row2b, col).setValue(value);
      // 若是 Market Salary Records 或 Candidate Records，自動更新 Update date/Update_date 欄位（代表這筆資料剛被更動過）
      if (sheetName === 'Market Salary Records' || sheetName === 'Candidate Records') {
        var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
        var updateColName = sheetName === 'Candidate Records' ? 'Update_date' : 'Update date';
        var updateCol = headers.indexOf(updateColName) + 1;
        if (updateCol > 0 && updateCol !== col) { // 如果剛好是在編輯 Update date 本身，就不要覆蓋使用者輸入的值
          var today = new Date();
          var dateStr = today.getFullYear()+'/'+(today.getMonth()+1)+'/'+today.getDate();
          sh.getRange(row2b, updateCol).setValue(dateStr);
        }
        if (sheetName === 'Candidate Records') stampCandidateScheduledDate_(sh, row2b, headers, col);
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (e.parameter.action === 'addRow') {
    try {
      var sheetName2 = e.parameter.sheet;
      var sh2 = ss.getSheetByName(sheetName2);
      var newRowValues = JSON.parse(e.parameter.values);
      // 若是 Market Salary Records 或 Candidate Records，自動填入 Update date/Update_date
      if (sheetName2 === 'Market Salary Records' || sheetName2 === 'Candidate Records') {
        var headers2 = sh2.getRange(1,1,1,sh2.getLastColumn()).getValues()[0];
        var updateColName2 = sheetName2 === 'Candidate Records' ? 'Update_date' : 'Update date';
        var updateCol2 = headers2.indexOf(updateColName2);
        if (updateCol2 >= 0) {
          var today2 = new Date();
          newRowValues[updateCol2] = today2.getFullYear()+'/'+(today2.getMonth()+1)+'/'+today2.getDate();
        }
      }
      sh2.appendRow(newRowValues);
      return ContentService.createTextOutput(JSON.stringify({ success: true, row: sh2.getLastRow() })).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (e.parameter.action === 'deleteRow') {
    try {
      var sheetName3 = e.parameter.sheet;
      var row3b = parseInt(e.parameter.row);
      var sh3 = ss.getSheetByName(sheetName3);
      sh3.deleteRow(row3b);
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ===== 分頁式載入：依畫面需要的資料分開讀取，不用每次都整份試算表全部讀一遍 =====
  if (e.parameter.action === 'getCoreData') return getCoreData_(ss);
  if (e.parameter.action === 'getHeadcountData') return getHeadcountData_(ss);
  if (e.parameter.action === 'getSalaryData') return getSalaryData_(ss);
  if (e.parameter.action === 'getSchedulingData') return getSchedulingData_(ss);

  // 沒有指定 action 時（例如直接打開網址測試），預設回傳核心資料，維持基本相容性
  return getCoreData_(ss);
}

// ===== 核心資料：Candidate Records + Manager Information（幾乎每個畫面都需要，第一次載入就會抓）=====
// 註：Phone Interview 工作表的欄位已全數併入 Candidate Records，這裡不再讀取 Phone Interview 分頁。
function getCoreData_(ss) {
  var sheet1 = ss.getSheetByName('Candidate Records');
  var data1 = sheet1.getDataRange().getValues();
  var h1 = data1[0];
  var candidates = [];
  for (var i = 1; i < data1.length; i++) {
    var r = data1[i];
    if (r[h1.indexOf('Name')] && r[h1.indexOf('Result')]) {
      var obj = { _row: i + 1 };
      h1.forEach(function(h, j) { obj[h] = r[j] ? String(r[j]) : ''; });
      candidates.push(obj);
    }
  }

  // 讀取 Result / 104_Position 欄位的下拉選單選項（從試算表的資料驗證規則抓取，跟著試算表自動更新）
  var resultOptions = getDropdownOptions_(sheet1, h1.indexOf('Result') + 1);
  var positionOptions = getDropdownOptions_(sheet1, h1.indexOf('104_Position') + 1);

  // ===== Manager Information：單位／Job Function／Name／Email =====
  // 用途：資料維護畫面填寫 Inviter 時，依 Name 比對自動帶入「單位」到 BU 欄位
  var managerInfo = [];
  var mgrInfoSheet = ss.getSheetByName('Manager Information');
  if (mgrInfoSheet) {
    var mgrInfoData = mgrInfoSheet.getDataRange().getValues();
    if (mgrInfoData.length) {
      var mgrInfoHeaders = mgrInfoData[0];
      var buIdx = mgrInfoHeaders.indexOf('單位');
      var jfIdx = mgrInfoHeaders.indexOf('Job Function');
      var nameIdx = mgrInfoHeaders.indexOf('Name');
      var emailIdx = mgrInfoHeaders.indexOf('Email');
      for (var mi = 1; mi < mgrInfoData.length; mi++) {
        var mrow = mgrInfoData[mi];
        if (nameIdx >= 0 && mrow[nameIdx]) {
          managerInfo.push({
            BU: buIdx >= 0 ? String(mrow[buIdx]||'').trim() : '',
            JobFunction: jfIdx >= 0 ? String(mrow[jfIdx]||'').trim() : '',
            Name: String(mrow[nameIdx]||'').trim(),
            Email: emailIdx >= 0 ? String(mrow[emailIdx]||'').trim() : ''
          });
        }
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      candidates: candidates,
      resultOptions: resultOptions,
      positionOptions: positionOptions,
      managerInfo: managerInfo,
      sheetHeaders: {
        'Candidate Records': h1
      }
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Headcount Records（只有打開 Headcount Overview 或資料維護的 Headcount 分頁才會抓）=====
function getHeadcountData_(ss) {
  var sheet3 = ss.getSheetByName('Headcount Records');
  var headcount = [];
  var hcHeaders = [];
  var hcDropdowns = {};
  if (sheet3) {
    var data3 = sheet3.getDataRange().getValues();
    hcHeaders = data3[0];
    for (var m = 1; m < data3.length; m++) {
      var r3 = data3[m];
      if (r3[hcHeaders.indexOf('Division')]) {
        var obj3 = { _row: m + 1 };
        hcHeaders.forEach(function(h, j) { obj3[h] = r3[j] !== '' && r3[j] !== null ? String(r3[j]) : ''; });
        headcount.push(obj3);
      }
    }
    // 每個欄位個別檢查是否設定了資料驗證下拉選單，有的話一併回傳給前端使用
    hcHeaders.forEach(function(h, j) {
      var opts = getDropdownOptions_(sheet3, j + 1);
      if (opts && opts.length) hcDropdowns[h] = opts;
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      headcount: headcount,
      headcountDropdowns: hcDropdowns,
      sheetHeaders: { 'Headcount Records': hcHeaders }
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Market Salary Records（只有打開 Market Salary Records 畫面才會抓）=====
function getSalaryData_(ss) {
  var sheet4 = ss.getSheetByName('Market Salary Records');
  var salaryRecords = [];
  var salaryHeaders = [];
  if (sheet4) {
    var data4 = sheet4.getDataRange().getValues();
    salaryHeaders = data4[0];
    for (var n = 1; n < data4.length; n++) {
      var r4 = data4[n];
      if (r4[salaryHeaders.indexOf('Company')]) {
        var obj4 = { _row: n + 1 };
        salaryHeaders.forEach(function(h, j) { obj4[h] = r4[j] !== '' && r4[j] !== null ? String(r4[j]) : ''; });
        salaryRecords.push(obj4);
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      salaryRecords: salaryRecords,
      sheetHeaders: { 'Market Salary Records': salaryHeaders }
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 面試時間協調 + 主管名冊（只有打開「面試時間協調」畫面才會抓）=====
function getSchedulingData_(ss) {
  var scheduleRecords = [];
  var schSheetRead = ss.getSheetByName('Interview Scheduling');
  if (schSheetRead) {
    var schData = schSheetRead.getDataRange().getValues();
    for (var s = 1; s < schData.length; s++) {
      var sr = schData[s];
      if (sr[0]) {
        scheduleRecords.push({
          Token: String(sr[0]||''),
          履歷代碼: String(sr[1]||''),
          Name: String(sr[2]||''),
          BU: String(sr[3]||''),
          JobFunction: String(sr[4]||''),
          Round: String(sr[5]||''),
          ManagerName: String(sr[6]||''),
          ManagerEmail: String(sr[7]||''),
          ManagerAvailability: String(sr[8]||''),
          ManagerFilledAt: String(sr[9]||''),
          CandidateAvailability: String(sr[10]||''),
          CandidateFilledAt: String(sr[11]||''),
          Status: String(sr[12]||''),
          FinalConfirmedTime: String(sr[13]||''),
          CreatedBy: String(sr[14]||''),
          CreatedAt: String(sr[15]||''),
          Notes: String(sr[16]||''),
          CreatedByName: String(sr[17]||''),
          CreatedByEmail: String(sr[18]||''),
          GroupId: String(sr[19]||'')
        });
      }
    }
  }

  var managerDirectory = [];
  var mgrSheet = ss.getSheetByName('Manager Email');
  if (mgrSheet) {
    var mgrData = mgrSheet.getDataRange().getValues();
    for (var mi = 1; mi < mgrData.length; mi++) {
      var mrow = mgrData[mi];
      if (mrow[1]) {
        managerDirectory.push({
          BU: String(mrow[0]||'').trim(),
          Name: String(mrow[1]||'').trim(),
          Email: String(mrow[2]||'').trim()
        });
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      scheduleRecords: scheduleRecords,
      managerDirectory: managerDirectory
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 從試算表指定欄位的資料驗證規則抓取下拉選單選項（支援「清單」與「範圍」兩種設定方式）
function getDropdownOptions_(sheet, col) {
  try {
    if (!col || col < 1) return [];
    var lastRow = Math.max(sheet.getLastRow(), 2);
    var range = sheet.getRange(2, col, lastRow - 1, 1);
    var validations = range.getDataValidations();
    for (var i = 0; i < validations.length; i++) {
      var rule = validations[i][0];
      if (!rule) continue;
      var criteria = rule.getCriteriaType();
      if (criteria === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
        return rule.getCriteriaValues()[0];
      }
      if (criteria === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
        var rangeArg = rule.getCriteriaValues()[0];
        return rangeArg.getValues().map(function(row){ return row[0]; })
          .filter(function(v){ return v !== '' && v !== null; })
          .map(function(v){ return String(v); });
      }
    }
  } catch (err) {
    Logger.log('getDropdownOptions_ error: ' + err);
  }
  return [];
}

// ============================================================
// ===== 診斷工具：手動在編輯器執行這個函式，檢查 Result 欄位的下拉選單抓取狀況 =====
// 執行方式：上方函式下拉選單選 debugResultOptions → 按執行 → 執行完後看「執行項」(Executions) 或
// 「檢視 → 記錄」(View → Logs) 裡印出來的內容，把結果複製貼給我看
// ============================================================
function debugResultOptions() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Candidate Records');
  if (!sheet) { Logger.log('找不到 Candidate Records 工作表'); return; }

  var headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  var col = headers.indexOf('Result') + 1;
  Logger.log('欄位名稱清單：' + JSON.stringify(headers));
  Logger.log('Result 是第幾欄（1=A, 2=B...）：' + col);

  if (col <= 0) {
    Logger.log('❌ 找不到叫做「Result」的欄位標題，請確認標題文字是否完全一致（含大小寫、空格）');
    return;
  }

  // 檢查第 2~6 列分別套用了什麼樣的資料驗證規則
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var checkRows = Math.min(lastRow - 1, 5);
  var range = sheet.getRange(2, col, checkRows, 1);
  var validations = range.getDataValidations();
  for (var i = 0; i < validations.length; i++) {
    var rule = validations[i][0];
    if (!rule) {
      Logger.log('第 ' + (i+2) + ' 列：這一格沒有設定資料驗證規則');
    } else {
      Logger.log('第 ' + (i+2) + ' 列：有資料驗證，類型是 ' + rule.getCriteriaType() + '，內容：' + JSON.stringify(rule.getCriteriaValues()));
    }
  }

  var options = getDropdownOptions_(sheet, col);
  Logger.log('最終抓到的選項清單：' + JSON.stringify(options));
  Logger.log(options.length ? '✅ 有成功抓到選項' : '❌ 沒有抓到任何選項，畫面上會改用內建的備用清單');
}

// ============================================================
// ===== 面試時間協調：輔助函式 =====
// ============================================================

function getOrCreateScheduleSheet(ss) {
  var sheet = ss.getSheetByName('Interview Scheduling');
  if (!sheet) {
    sheet = ss.insertSheet('Interview Scheduling');
    sheet.appendRow([
      'Token','履歷代碼','Name','BU','Job Function','Round',
      'ManagerName','ManagerEmail','ManagerAvailability','ManagerFilledAt',
      'CandidateAvailability','CandidateFilledAt','Status','FinalConfirmedTime',
      'CreatedBy','CreatedAt','Notes','CreatedByName','CreatedByEmail','GroupId'
    ]);
    sheet.getRange(1,1,1,20).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findScheduleRowByToken_(sheet, token) {
  if (!token) return null;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(token)) return i + 1;
  }
  return null;
}

// 找出同一批（同一個 GroupId）邀約的所有列，方便一次更新候選人／HR 方便時間
function findScheduleRowsByGroupId_(sheet, groupId) {
  if (!groupId) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][19] || '') === String(groupId)) rows.push(i + 1);
  }
  return rows;
}

function updateScheduleStatus_(sheet, row) {
  var mgr = sheet.getRange(row, 9).getValue();
  var cand = sheet.getRange(row, 11).getValue();
  var currentStatus = sheet.getRange(row, 13).getValue();
  if (currentStatus === '已確認') return; // 已確認的邀約不再自動改變狀態
  var status;
  if (mgr && cand) status = '待比對確認';
  else if (mgr) status = '等待候選人時間';
  else status = '等待主管填寫';
  sheet.getRange(row, 13).setValue(status);
}

function formatNowDateTime_() {
  var d = new Date();
  return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate()+' '+
    String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}

function renderManagerSchedulePage(ss, token) {
  var sheet = ss.getSheetByName('Interview Scheduling');
  var scriptUrl = ScriptApp.getService().getUrl();
  var record = null;
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(token)) { record = data[i]; break; }
    }
  }
  if (!record) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:-apple-system,sans-serif;padding:60px 24px;text-align:center;color:#6B7280;">' +
      '找不到這個邀約，連結可能已失效，請聯繫招募人員。</div>'
    ).setTitle('面試時間回覆');
  }

  var name = escapeHtml_(record[2]);
  var jobFunction = escapeHtml_(record[4]);
  var round = escapeHtml_(record[5] || '面試');
  var managerName = escapeHtml_(record[6]);
  var existing = escapeHtml_(record[8] || '');
  var candidateAvailability = escapeHtml_(record[10] || '');
  var tokenSafe = escapeHtml_(token);

  var candidateBlockHtml = candidateAvailability
    ? '<div class="cand-box"><div class="cand-label">📋 候選人／HR 目前回報的方便時間（僅供參考）</div>' +
      '<div class="cand-text">' + candidateAvailability.replace(/\n/g, '<br>') + '</div></div>'
    : '';

  var html = '' +
    '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>面試時間回覆</title>' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Microsoft JhengHei",sans-serif;background:#F7F8FA;margin:0;padding:24px;color:#1A1D23;}' +
    '.card{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.08);}' +
    'h2{font-size:18px;margin:0 0 6px;}' +
    'p.sub{color:#6B7280;font-size:13px;margin:0 0 20px;line-height:1.6;}' +
    '.cand-box{background:#F0FDFA;border:1px solid #99F6E4;border-radius:8px;padding:12px 14px;margin-bottom:16px;}' +
    '.cand-label{font-size:11px;font-weight:600;color:#0F766E;margin-bottom:6px;}' +
    '.cand-text{font-size:13px;color:#134E4A;line-height:1.6;white-space:pre-wrap;}' +
    'textarea{width:100%;min-height:150px;padding:12px;border:1.5px solid #E8EAED;border-radius:8px;font-size:14px;font-family:inherit;box-sizing:border-box;resize:vertical;}' +
    'button{margin-top:14px;background:#4F46E5;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:14px;cursor:pointer;}' +
    '.hint{font-size:12px;color:#9CA3AF;margin-top:8px;line-height:1.6;}' +
    '</style></head><body>' +
    '<div class="card">' +
    '<h2>面試時間回覆</h2>' +
    '<p class="sub">' + (managerName ? managerName + ' 您好，' : '您好，') +
    '請提供您方便的時間，安排與 <b>' + name + '</b> 的' + round + '（' + jobFunction + '）</p>' +
    candidateBlockHtml +
    '<form method="GET" action="' + scriptUrl + '">' +
    '<input type="hidden" name="action" value="submitManagerAvailability">' +
    '<input type="hidden" name="token" value="' + tokenSafe + '">' +
    '<textarea name="text" placeholder="請直接輸入方便的日期與時段，例如：7/3(四) 9:30~11:00、7/4(五) 15:00~17:30">' + existing + '</textarea>' +
    '<div class="hint">請盡量寫出具體日期（例如幾月幾號），方便系統協助比對候選人的時間</div>' +
    '<button type="submit">送出</button>' +
    '</form></div></body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('面試時間回覆');
}

function submitManagerAvailability(ss, token, text) {
  var sheet = getOrCreateScheduleSheet(ss);
  var row = findScheduleRowByToken_(sheet, token);
  var html;
  if (row) {
    sheet.getRange(row, 9).setValue(text || '');
    sheet.getRange(row, 10).setValue(formatNowDateTime_());
    updateScheduleStatus_(sheet, row);
    html = '<div style="font-family:-apple-system,sans-serif;padding:60px 24px;text-align:center;">' +
      '<div style="font-size:40px;">✅</div>' +
      '<div style="margin-top:12px;font-size:16px;color:#1A1D23;">已收到您的回覆，謝謝！</div>' +
      '<div style="margin-top:6px;font-size:13px;color:#6B7280;">招募人員確認雙方時間後會再與您聯繫</div>' +
      '</div>';
  } else {
    html = '<div style="font-family:-apple-system,sans-serif;padding:60px 24px;text-align:center;color:#6B7280;">' +
      '找不到這個邀約，請聯繫招募人員。</div>';
  }
  return HtmlService.createHtmlOutput(html).setTitle('面試時間回覆');
}

function escapeHtml_(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// ===== 手動測試用：在 Apps Script 編輯器直接執行這個函式一次 =====
// 用途：(1) 立刻建立「Interview Scheduling」分頁 (2) 觸發 MailApp 寄信授權視窗
// 執行方式：上方函式下拉選單選 setupScheduleSheet → 按執行(Run) → 依畫面完成授權
// ============================================================
function setupScheduleSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateScheduleSheet(ss);
  Logger.log('Interview Scheduling 分頁已就緒：' + sheet.getName());

  // 觸發寄信授權（會寄一封測試信到你自己的帳號，收到代表寄信功能正常）
  var myEmail = Session.getActiveUser().getEmail();
  if (myEmail) {
    sendScheduleEmail_(myEmail, '【測試】面試時間協調功能設定完成', '這是一封測試信，收到代表 Apps Script 的寄信授權已經設定成功，可以正常使用面試時間協調功能了。');
    Logger.log('測試信已寄至：' + myEmail);
  }
}
