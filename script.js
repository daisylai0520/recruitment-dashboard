// 試過 /a/~/ 和 /a/gmail.com/ 兩種網址寫法，都沒有解決持續出現 404 的問題（甚至可能是這幾次改網址
// 本身造成的，因為這類 URL 改寫比較適合「瀏覽器直接開網址」，不一定適合這裡用 fetch() 背景呼叫的情境），
// 先改回最原始、最單純的網址，避免節外生枝。真正原因需要看 Apps Script 執行記錄才能確定（見對話回覆）。
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby0h1OkoC_xNWeAAbuh4cBicbTl4B8g1KDtL-s2YK9f80TYjIyxQtdeu9RkWFQVtY3pnw/exec';

// Apps Script 的 /exec 網址背後其實會先轉址到一個「一次性」的 script.googleusercontent.com 網址才是真正的內容
//（Google 官方文件說明如此）。如果瀏覽器把這次轉址結果快取住、下次同樣網址直接重用快取，那個一次性網址
// 可能已經失效，就會出現 HTTP 404——但因為根本沒有真的再呼叫一次 Apps Script，所以「執行記錄」會看起來完全正常，
// 這也是為什麼查執行記錄都顯示「已完成」、卻還是常常跳出 404 的原因。
// 這裡讓每一次呼叫都帶一個不會重複的參數＋明確關閉快取，確保每次都是真正重新請求，不會誤用到過期的轉址結果。
function noCacheUrl(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_cb=' + Date.now() + Math.random().toString(36).slice(2);
}

// 即使已經避開了轉址快取問題，Apps Script 本身偶爾還是會因為執行逾時、同時執行數量限制等
// 暫時性狀況回應失敗，這類狀況通常「重試一次馬上就會成功」。這裡統一做「自動重試」：
// 失敗時稍等一下再試（最多重試 2 次，等待時間逐次拉長），三次都失敗才真的顯示錯誤，
// 這樣「時不時」跳出的 404／連線失敗訊息，大多能在使用者沒察覺的情況下自動恢復。
async function fetchJsonWithRetry(urlBuilder, options, retries) {
  var attempts = (retries === undefined) ? 2 : retries;
  var lastErr;
  for (var i = 0; i <= attempts; i++) {
    try {
      var res = await fetch(urlBuilder(), options);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        await new Promise(function (r) { setTimeout(r, 500 * (i + 1)); });
      }
    }
  }
  throw lastErr;
}

var userRole = null;
var allData=[], salaryData=[], scheduleData=[], managerDirectoryData=[], managerInfoData=[], resultOptions=[], positionOptions=[];
// 「分類Result」工作表的 階段／分類1／分類2／Result 對照，人選進度統計樹狀圖依這個動態分組顯示
var resultCategories = [];
// allDataFull：完整（未依單位過濾）的人選名單，只給「新增人選時檢查是否已有其他 HR/單位約過」這個功能用，
// 畫面上其他地方（看板、搜尋、篩選…）一律還是用有經過單位過濾的 allData，不會讓 HR 看到不屬於自己單位的完整資料。
var allDataFull = [];
var currentTab='kanban';

// ---- 身分 / 權限管理 ----
// hrDirectoryData／unitHrMappingData 一開始（角色選擇畫面）就會抓一次輕量版（只有 HR 名冊 + 單位對應表），
// 進到「權限管理」畫面時再用 getPermissionData 補齊 permUnitOptions／permHrOptions 並重新整包覆蓋。
var hrDirectoryData = [], unitHrMappingData = [], permUnitOptions = [], permHrOptions = [];
var currentHRName = null;   // 目前登入的 HR 姓名；管理者是 '管理者'
var currentHRUnits = null;  // 目前登入的 HR 負責哪些單位；null 代表不限制（管理者）
var isAdmin = false;

// 依現有多選欄位的儲存慣例（用「、」分隔多個值，見 MULTI_SELECT_FIELDS）拆成陣列
function splitMultiValue(s) {
  return String(s||'').split('、').map(function(v){ return v.trim(); }).filter(Boolean);
}

// 剛存檔的欄位短時間內的保護機制：每 5 分鐘會有一次背景自動同步（見底部 setInterval(fetchData,...)），
// 如果使用者剛編輯完某個欄位、儲存動作跟這次背景同步前後腳發生，抓回來的那份資料有可能是「同步當下」的舊快照
// （還沒反映剛剛的編輯），直接整批覆蓋回 allData／allDataFull 的話，畫面上剛打好的內容會像是突然消失或被還原。
// 所以剛存檔的欄位在這個保護視窗內（20 秒），重新整理資料時會用剛剛存的值蓋回去，而不是照單全收剛抓到的舊值；
// 超過保護時間就不再特別處理，讓資料照正常流程以伺服器最新版本為準（例如真的被別人改過）。
var recentFieldEdits = {};
var EDIT_PROTECTION_MS = 20000;
function rememberRecentEdit(sheet, row, field, value) {
  recentFieldEdits[sheet+'|'+row+'|'+field] = { value: value, ts: Date.now() };
}
function reapplyRecentEdits(sheet, records) {
  var now = Date.now();
  Object.keys(recentFieldEdits).forEach(function(key){
    var parts = key.split('|');
    if (parts[0] !== sheet) return;
    var entry = recentFieldEdits[key];
    if (now - entry.ts > EDIT_PROTECTION_MS) { delete recentFieldEdits[key]; return; }
    var rec = records.find(function(r){ return String(r._row) === String(parts[1]); });
    if (rec) rec[parts[2]] = entry.value;
  });
}

// Job Function 欄位可能是多選（用「、」分隔存多個值），篩選選項要把每筆資料拆開再去重，
// 不要把整串「A、B、C」當成一個選項；單選的資料 splitMultiValue 會直接回傳單一值，不受影響。
function buildMultiValueOptions(records, getValue) {
  var set = new Set();
  records.forEach(function(r){
    splitMultiValue(getValue(r)).forEach(function(v){ if (v) set.add(v); });
  });
  return [...set].sort();
}

// Candidate 畫面的時間篩選：使用者按過「清除」（或手動把日期都清空）之後，就不要再自動幫忙補「本週」，
// 直到他自己又設定了一個新的時間範圍為止。切換身分／重新登入時會重設。
var candMaintenanceDateCleared = false;
// 舊的單選篩選狀態變數已改用 multiFilterState（見下方通用多選篩選元件），這裡保留 activeFilter 給 Recruitment Status 用
var activeFilter=null;
var selectedCard=null;

// Stage definitions
// 2026/07 對齊「分類Result」工作表的 19 個 Result 分類（原本這裡是舊制度的階段名稱，跟現在的
// Result 選項對不起來，例如「未回覆」「確認主管邀約意願」「HR不邀約電訪」「主管不邀約面試」
// 這幾個字串現在都不存在於「分類Result」裡了，導致這幾個 Result 值的人選在看板上完全不會出現）
var PHONE_STAGES = ['排電訪','待電訪','已致電未接'];
// Overview 畫面的看板不顯示「已致電未接」這一欄；Candidate Search 保留完整電訪流程
var CANDIDATE_OVERVIEW_PHONE_STAGES = PHONE_STAGES.filter(function(stage){ return stage !== '已致電未接'; });
var INTERVIEW_STAGES = ['確認主管面試意願','排面試','待面試'];
var OFFER_STAGES = ['確認主管錄取意願','確認人選錄取意願','錄取'];
// 「其他」：待確認/暫緩，先不歸類到電訪/面試/錄取，也不算已結束，獨立一欄方便追蹤
var OTHER_STAGES = ['待確認/暫緩'];
// 「已面試，排複試」歸到結束/不推進（複試改由主管直接安排，這個階段對 HR 來說已經結束追蹤）
var COLLAPSE_STAGES = ['104已邀約未回覆','人選婉拒電訪','其他主管/近期已邀約','不建議邀約','已面試，排複試','婉拒面試','未錄取','婉拒 Offer','已關閉履歷'];
var ALL_ACTIVE_STAGES = PHONE_STAGES.concat(INTERVIEW_STAGES).concat(OFFER_STAGES);

var STAGE_COLORS = {
  '104已邀約未回覆':'#9CA3AF','排電訪':'#F59E0B','已致電未接':'#FBBF24','待電訪':'#10B981',
  '確認主管面試意願':'#60A5FA','排面試':'#3B82F6','待面試':'#8B5CF6',
  '確認主管錄取意願':'#34D399','確認人選錄取意願':'#059669','錄取':'#16A34A',
  '待確認/暫緩':'#8B5CF6','其他主管/近期已邀約':'#9CA3AF','不建議邀約':'#9CA3AF','已面試，排複試':'#6B7280',
  '人選婉拒電訪':'#EF4444','婉拒面試':'#EF4444','未錄取':'#EF4444','婉拒 Offer':'#EF4444','已關閉履歷':'#6B7280'
};

// ---- helpers ----
function parseDateTime(s) {
  if (!s) return null;
  s = String(s).trim();
  var d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear()>2000) return d;
  var m = s.match(/(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})\s*(上午|中午|下午)?/);
  if (m) {
    var yr=m[1]?parseInt(m[1]):new Date().getFullYear();
    var hr=m[4]==='下午'?13:m[4]==='中午'?12:m[4]==='上午'?8:0;
    return new Date(yr,parseInt(m[2])-1,parseInt(m[3]),hr,0);
  }
  return null;
}
function fmtDate(s) {
  if (!s) return '';
  var raw=String(s).trim();
  if (raw.includes('整天')) {
    var dmAD = raw.match(/(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})/);
    if (dmAD) {
      var yrAD = dmAD[1] ? dmAD[1] : new Date().getFullYear();
      return yrAD+'/'+String(parseInt(dmAD[2])).padStart(2,'0')+'/'+String(parseInt(dmAD[3])).padStart(2,'0')+'整天';
    }
    return raw;
  }
  if (raw.includes('上午')||raw.includes('中午')||raw.includes('下午')) {
    var period=raw.includes('上午')?'上午':raw.includes('中午')?'中午':'下午';
    var dm=raw.match(/(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})/);
    if (dm) {
      var yr=dm[1]?dm[1]:new Date().getFullYear();
      return yr+'/'+String(parseInt(dm[2])).padStart(2,'0')+'/'+String(parseInt(dm[3])).padStart(2,'0')+' '+period;
    }
    return raw;
  }
  var rangeMatch = raw.match(/(\d{1,2}):(\d{2})\s*[~\-–到至]\s*(\d{1,2}):(\d{2})/);
  if (rangeMatch) {
    var timeRangeStr = String(parseInt(rangeMatch[1])).padStart(2,'0')+':'+rangeMatch[2]+'~'+String(parseInt(rangeMatch[3])).padStart(2,'0')+':'+rangeMatch[4];
    var dmR = raw.match(/(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})/);
    if (dmR) {
      var yrR = dmR[1] ? dmR[1] : new Date().getFullYear();
      return yrR+'/'+String(parseInt(dmR[2])).padStart(2,'0')+'/'+String(parseInt(dmR[3])).padStart(2,'0')+' '+timeRangeStr;
    }
    return timeRangeStr;
  }
  var d=new Date(raw);
  if (!isNaN(d.getTime())&&d.getFullYear()>2000) {
    return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  }
  return raw;
}
function getSortTs(d) {
  var t=(d.Result==='待電訪'||d.Result==='排電訪'||d.Result==='已電訪')?(d.Interview_date||d['Phone Interview_date']||''):(d.Interview_date||'');
  if (!t) return Infinity;
  var dt=parseDateTime(t); return dt?dt.getTime():Infinity;
}
function isPast(s) {
  if (!s) return false;
  var d=parseDateTime(s); if (!d) return false;
  var y=new Date(); y.setHours(0,0,0,0); return d<y;
}
function isDonePhone(d){return isPast(d.Interview_date||d['Phone Interview_date']||'');}
function isDoneInterview(d){return isPast(d.Interview_date||'');}

// ===== 共用：日期範圍篩選元件 =====
var dateFilterState = {}; // { pageKey: {field, start, end} }

function buildDateFilterHtml(pageKey, fieldOptions, quickRanges) {
  var optHtml = fieldOptions.map(function(f){return '<option value="'+f.value+'">'+f.label+'</option>';}).join('');
  var quickHtml = (quickRanges||[]).map(function(q){
    return '<button type="button" class="pos-btn date-quick-btn" id="dfq-'+pageKey+'-'+q.range+'" onclick="quickDateFilter(\''+pageKey+'\',\''+q.range+'\')">'+q.label+'</button>';
  }).join('');
  return '<div class="date-filter-group">'+
    '<div class="filter-group-label">時間篩選</div>'+
    '<div class="date-filter-inputs">'+
      '<select id="df-field-'+pageKey+'" onchange="applyDateFilter(\''+pageKey+'\')">'+optHtml+'</select>'+
      '<input type="date" id="df-start-'+pageKey+'" onchange="applyDateFilter(\''+pageKey+'\')">'+
      '<span style="color:var(--text-tertiary);font-size:12px;">至</span>'+
      '<input type="date" id="df-end-'+pageKey+'" onchange="applyDateFilter(\''+pageKey+'\')">'+
      '<span class="date-filter-clear" onclick="clearDateFilter(\''+pageKey+'\')">清除</span>'+
      quickHtml+
    '</div>'+
  '</div>';
}

// yyyy-mm-dd，給 <input type="date"> 用（跟 getTodayDateStr 的 yyyy/mm/dd 格式分開，避免混用出錯）
function fmtISODate(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
// 把試算表存的日期（例如 2026/08/15）轉成 <input type="date"> 需要的 yyyy-mm-dd；解析不出來就留空白，不擋輸入
function dateOnlyToISO(raw) {
  if (!raw) return '';
  var d = parseDateTime(String(raw));
  return d ? fmtISODate(d) : '';
}

// 快速時間區間按鈕：本月／過去一個月，點擊後直接帶入起訖日期並套用篩選
function quickDateFilter(pageKey, range) {
  var fieldEl = document.getElementById('df-field-'+pageKey);
  var startEl = document.getElementById('df-start-'+pageKey);
  var endEl = document.getElementById('df-end-'+pageKey);
  if (!fieldEl || !startEl || !endEl) return;
  var today = new Date(); today.setHours(0,0,0,0);
  var start, end;
  if (range === 'thisWeek') {
    var dow = (today.getDay() + 6) % 7; // 週一為一週的第一天
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow);
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow + 6);
  } else if (range === 'thisMonth') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth()+1, 0);
  } else if (range === 'past1m') {
    end = today;
    start = new Date(today.getFullYear(), today.getMonth()-1, today.getDate()+1);
  } else {
    return;
  }
  startEl.value = fmtISODate(start);
  endEl.value = fmtISODate(end);
  dateFilterState[pageKey] = {
    field: fieldEl.value,
    start: new Date(start.getFullYear(),start.getMonth(),start.getDate(),0,0,0),
    end: new Date(end.getFullYear(),end.getMonth(),end.getDate(),23,59,59),
    quickRange: range
  };
  if (pageKey === 'candidateMaintenance') candMaintenanceDateCleared = false;
  updateDateQuickBtnActive(pageKey);
  triggerPageRerender(pageKey);
}

// 快速按鈕的反白狀態；手動改日期或按清除時，都要讓快速按鈕跟著取消反白
function updateDateQuickBtnActive(pageKey) {
  var state = dateFilterState[pageKey];
  var activeRange = state && state.quickRange;
  ['thisWeek','thisMonth','past1m'].forEach(function(r){
    var btn = document.getElementById('dfq-'+pageKey+'-'+r);
    if (btn) btn.classList.toggle('active', activeRange === r);
  });
}

function applyDateFilter(pageKey) {
  var fieldEl = document.getElementById('df-field-'+pageKey);
  var startEl = document.getElementById('df-start-'+pageKey);
  var endEl = document.getElementById('df-end-'+pageKey);
  var start = startEl.value ? new Date(startEl.value+'T00:00:00') : null;
  var end = endEl.value ? new Date(endEl.value+'T23:59:59') : null;
  dateFilterState[pageKey] = { field: fieldEl.value, start: start, end: end };
  // 手動把起訖日期都清空也算是「使用者主動清除」，跟按「清除」連結一樣，不要再自動幫忙補本週
  if (pageKey === 'candidateMaintenance') candMaintenanceDateCleared = !start && !end;
  updateDateQuickBtnActive(pageKey);
  triggerPageRerender(pageKey);
}

function clearDateFilter(pageKey) {
  var startEl = document.getElementById('df-start-'+pageKey);
  var endEl = document.getElementById('df-end-'+pageKey);
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  delete dateFilterState[pageKey];
  if (pageKey === 'candidateMaintenance') candMaintenanceDateCleared = true;
  updateDateQuickBtnActive(pageKey);
  triggerPageRerender(pageKey);
}

function dateFilterPass(pageKey, rec) {
  var state = dateFilterState[pageKey];
  if (!state || !state.field || (!state.start && !state.end)) return true;
  var raw = rec[state.field] || rec[state.field.replace('_',' ')] || '';
  var d = parseDateTime(raw);
  if (!d) return false;
  if (state.start && d < state.start) return false;
  if (state.end && d > state.end) return false;
  return true;
}

function triggerPageRerender(pageKey) {
  var renderMap = {
    kanban: renderKanban,
    overview: renderOverview,
    hc: renderHeadcount,
    candidateSearch: renderCandidateSearch,
    candidateMaintenance: renderCandQuery,
    trends: renderTrends,
    'export': updateExportPreview
  };
  if (renderMap[pageKey]) renderMap[pageKey]();
}

function initDateFilterSlots() {
  var candFields = [
    {value:'invite_date', label:'invite_date'},
    {value:'Phone Interview_date', label:'Phone Interview_date'},
    {value:'Interview_date', label:'Interview_date'},
    {value:'Result Update_date', label:'Result Update_date'}
  ];
  // 全站時間篩選統一比照「Candidate」畫面：欄位、快速範圍按鈕都一致；每個畫面一打開都自動套用「本週」
  var maintainQuickRanges = [{label:'本週',range:'thisWeek'},{label:'本月',range:'thisMonth'},{label:'過去一個月',range:'past1m'}];
  var slots = {
    'kbDateFilterSlot': {key:'kanban', fields:candFields, quickRanges:maintainQuickRanges, defaultQuickRange:'thisWeek'},
    'ovDateFilterSlot': {key:'overview', fields:candFields, quickRanges:maintainQuickRanges, defaultQuickRange:'thisWeek'},
    'csDateFilterSlot': {key:'candidateSearch', fields:candFields, quickRanges:maintainQuickRanges, defaultQuickRange:'thisWeek'},
    // Candidate 畫面不自動預設時間範圍：一打開先不顯示任何人選，等使用者第一次套用篩選（含手動選時間）時，
    // renderCandQuery() 裡才會在還沒設定時間範圍的情況下自動補上「本週」
    'candDateFilterSlot': {key:'candidateMaintenance', fields:candFields, quickRanges:maintainQuickRanges},
    'trDateFilterSlot': {key:'trends', fields:candFields, quickRanges:maintainQuickRanges, defaultQuickRange:'thisWeek'},
    'expDateFilterSlot': {key:'export', fields:candFields, quickRanges:maintainQuickRanges, defaultQuickRange:'thisWeek'},
    'hcDateFilterSlot': {key:'hc', fields:[{value:'Update_date',label:'Update_date（缺額更新時間，依異動記錄推算暫不支援）'}], disabled:true}
  };
  Object.keys(slots).forEach(function(slotId){
    var el = document.getElementById(slotId);
    if (!el) return;
    var cfg = slots[slotId];
    if (cfg.disabled) { el.innerHTML = ''; return; } // Headcount 沒有日期欄位可篩選，跳過
    if (!dateFilterState[cfg.key]) {
      el.innerHTML = buildDateFilterHtml(cfg.key, cfg.fields, cfg.quickRanges);
      // 每個畫面一打開都自動帶出「本週」資料，不用使用者手動操作
      if (cfg.defaultQuickRange) quickDateFilter(cfg.key, cfg.defaultQuickRange);
    }
  });
}

function jfClass(jf) {
  var s = String(jf||'');
  if (s.includes('Sales')) return 'jf-sales';
  if (s.includes('FAE')) return 'jf-fae';
  return '';
}

function showToast(msg) {
  var t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},2500);
}

// ---- fetch ----
// ===== 分頁式載入：每個畫面只在真正被打開時，才去抓它需要的資料 =====
var loadedResources = { core: false, headcount: false, salary: false, scheduling: false, permissions: false };

// ===== 「上次資料先顯示、背景重新整理」快取機制 =====
// 把每個資源最後一次成功抓到的原始 JSON 存進瀏覽器的 localStorage；下次開網頁／切分頁時，
// 如果本地還沒抓過這個資源但瀏覽器有存過快取，就先用快取資料把畫面畫出來（可能是幾分鐘前的舊資料），
// 同時在背景重新抓最新資料，抓完再整個畫面重畫一次——比起每次都要等 Apps Script 回應完才看得到任何東西快很多。
var CACHE_PREFIX = 'rc_cache_v1_';
function cacheSet(resource, json) {
  try { localStorage.setItem(CACHE_PREFIX+resource, JSON.stringify(json)); } catch(e) {}
}
function cacheGet(resource) {
  try {
    var raw = localStorage.getItem(CACHE_PREFIX+resource);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function setSyncStatus(state, msg) {
  var dot=document.getElementById('syncDot'), txt=document.getElementById('syncText');
  if (dot) dot.className = 'sync-dot' + (state==='loading' ? ' loading' : state==='error' ? ' error' : '');
  if (txt) txt.textContent = msg;
}

function applyCoreData(json) {
  allData=(json.candidates||[]).filter(function(d){return d.Name&&d.Result;});
  // 保留一份完整（未依單位過濾）名單，只給新增人選時的重複檢查使用
  allDataFull = allData.slice();
  // 剛編輯完的欄位如果還在保護時間內，用剛存的值蓋掉這次抓回來的（可能較舊的）快照，避免看起來像是自動被存成別的值／被還原
  reapplyRecentEdits('Candidate Records', allDataFull);
  // 一般 HR 身分（非管理者）：只留下「單位」有落在自己負責範圍內的人選資料
  if (!isAdmin && currentHRUnits) {
    allData = allData.filter(function(d){
      var units = splitMultiValue(d['單位']);
      return units.some(function(u){ return currentHRUnits.indexOf(u) >= 0; });
    });
  }
  resultOptions=(json.resultOptions||[]).map(function(v){return String(v).trim();}).filter(Boolean);
  // 「分類Result」工作表的 階段／分類1／分類2 欄位，人選進度統計樹狀圖靠這個動態分組（不再寫死在程式裡）
  resultCategories=(json.resultCategories||[]).filter(function(rc){return rc && rc.Result;});
  positionOptions=(json.positionOptions||[]).map(function(v){return String(v).trim();}).filter(Boolean);
  managerInfoData=(json.managerInfo||[]).filter(function(d){return d.Name;});
  Object.assign(maintainHeaders, json.sheetHeaders || {});
  loadedResources.core = true;
}
async function fetchCoreData() {
  var json = await fetchJsonWithRetry(function(){ return noCacheUrl(APPS_SCRIPT_URL + '?action=getCoreData'); }, {cache:'no-store'});
  cacheSet('core', json);
  applyCoreData(json);
}

// ---- 身分選擇畫面：一開始就抓 HR 名冊 + 單位對應表，用來畫出「我是 XXX」的按鈕 ----
async function fetchIdentityData() {
  try {
    var json = await fetchJsonWithRetry(function(){ return noCacheUrl(APPS_SCRIPT_URL + '?action=getIdentityData'); }, {cache:'no-store'});
    hrDirectoryData = (json.hrDirectory||[]).filter(function(d){return d['HR姓名'];});
    unitHrMappingData = (json.unitHrMapping||[]).filter(function(d){return d['單位']||d['負責HR'];});
    renderRoleScreenIdentities();
  } catch(e) {
    var bpEl = document.getElementById('hrIdentityButtonsBP');
    var recEl = document.getElementById('hrIdentityButtonsRecruiter');
    var errHtml = '<div style="font-size:12px;color:#EF4444;">身分清單載入失敗，請重新整理頁面（'+e.message+'）</div>';
    if (bpEl) bpEl.innerHTML = errHtml;
    if (recEl) recEl.innerHTML = '';
  }
}

function buildHRIdentityButton(name) {
  var nameSafe = String(name).replace(/'/g,"\\'");
  var nameDisp = String(name).replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<button onclick="selectHRIdentity(\''+nameSafe+'\')" style="width:150px;padding:16px 14px;border:1.5px solid var(--border);border-radius:12px;background:var(--surface);cursor:pointer;transition:all .15s;font-size:14px;font-weight:600;color:var(--text-primary);" onmouseover="this.style.borderColor=\'#4F46E5\';this.style.boxShadow=\'0 4px 16px rgba(79,70,229,.12)\'" onmouseout="this.style.borderColor=\'#E8EAED\';this.style.boxShadow=\'none\'">'+nameDisp+'</button>';
}

// 依角色分兩欄顯示：BP 一欄、Recruiter 一欄（角色未設定時預設歸在 Recruiter 欄）
function renderRoleScreenIdentities() {
  var bpEl = document.getElementById('hrIdentityButtonsBP');
  var recEl = document.getElementById('hrIdentityButtonsRecruiter');
  if (!bpEl || !recEl) return;
  var bpList = hrDirectoryData.filter(function(h){ return h['角色'] === 'BP'; });
  var recList = hrDirectoryData.filter(function(h){ return h['角色'] !== 'BP'; });
  bpEl.innerHTML = bpList.length ? bpList.map(function(h){ return buildHRIdentityButton(h['HR姓名']); }).join('') : '<div style="font-size:11px;color:var(--text-tertiary);">尚未設定</div>';
  recEl.innerHTML = recList.length ? recList.map(function(h){ return buildHRIdentityButton(h['HR姓名']); }).join('') : '<div style="font-size:11px;color:var(--text-tertiary);">尚未設定</div>';
}

function getUnitsForHR(name) {
  return unitHrMappingData
    .filter(function(m){ return splitMultiValue(m['負責HR']).indexOf(name) >= 0; })
    .map(function(m){ return String(m['單位']||'').trim(); })
    .filter(Boolean);
}

// Manager Information 工作表（單位／Job Function／Name／Email）依姓名比對出「單位」，
// 供資料維護畫面填寫 Inviter 時自動帶入 單位 使用
function findBUByInviterName(name) {
  var target = String(name||'').trim().toLowerCase();
  if (!target) return '';
  var match = managerInfoData.find(function(m){ return String(m.Name||'').trim().toLowerCase() === target; });
  return match ? (match.BU || '') : '';
}

function applyHeadcountData(json) {
  headcountDropdownData = json.headcountDropdowns || {};
  rebuildHeadcountDropdowns();
  Object.assign(maintainHeaders, json.sheetHeaders || {});
  var newHcRecords = json.headcount||[];
  reapplyRecentEdits('Headcount Records', newHcRecords);
  loadHeadcountData(newHcRecords);
  loadedResources.headcount = true;
}
async function fetchHeadcountData() {
  var json = await fetchJsonWithRetry(function(){ return noCacheUrl(APPS_SCRIPT_URL + '?action=getHeadcountData'); }, {cache:'no-store'});
  cacheSet('headcount', json);
  applyHeadcountData(json);
}

function applySalaryData(json) {
  salaryData=(json.salaryRecords||[]).filter(function(d){return d.Company;});
  reapplyRecentEdits('Market Salary Records', salaryData);
  Object.assign(maintainHeaders, json.sheetHeaders || {});
  loadedResources.salary = true;
}
async function fetchSalaryData() {
  var json = await fetchJsonWithRetry(function(){ return noCacheUrl(APPS_SCRIPT_URL + '?action=getSalaryData'); }, {cache:'no-store'});
  cacheSet('salary', json);
  applySalaryData(json);
}

function applySchedulingData(json) {
  scheduleData=(json.scheduleRecords||[]).filter(function(d){return d.Token;});
  managerDirectoryData=(json.managerDirectory||[]).filter(function(d){return d.Name;});
  loadedResources.scheduling = true;
}
async function fetchSchedulingData() {
  var json = await fetchJsonWithRetry(function(){ return noCacheUrl(APPS_SCRIPT_URL + '?action=getSchedulingData'); }, {cache:'no-store'});
  cacheSet('scheduling', json);
  applySchedulingData(json);
}

// 權限管理畫面：Candidate Records 目前實際出現過的「單位」「負責HR」選項 + 目前的對應表／HR 名冊設定
function applyPermissionData(json) {
  permUnitOptions = (json.unitOptions||[]).map(function(v){return String(v).trim();}).filter(Boolean);
  permHrOptions = (json.hrOptions||[]).map(function(v){return String(v).trim();}).filter(Boolean);
  unitHrMappingData = (json.unitHrMapping||[]).filter(function(d){return d['單位']||d['負責HR'];});
  hrDirectoryData = (json.hrDirectory||[]).filter(function(d){return d['HR姓名'];});
  loadedResources.permissions = true;
}
async function fetchPermissionData() {
  var json = await fetchJsonWithRetry(function(){ return noCacheUrl(APPS_SCRIPT_URL + '?action=getPermissionData'); }, {cache:'no-store'});
  cacheSet('permissions', json);
  applyPermissionData(json);
}

var RESOURCE_FETCHERS = { core: fetchCoreData, headcount: fetchHeadcountData, salary: fetchSalaryData, scheduling: fetchSchedulingData, permissions: fetchPermissionData };
var RESOURCE_APPLIERS = { core: applyCoreData, headcount: applyHeadcountData, salary: applySalaryData, scheduling: applySchedulingData, permissions: applyPermissionData };

// 切換到某個畫面時呼叫：如果這個畫面需要的資料還沒載入過，才去抓；已經載入過就直接用現有的，不用整份重讀。
// 如果瀏覽器有存過這個資源上次成功抓到的快取，就先用快取資料把畫面畫出來（不用等網路），
// 同時在背景重新抓最新資料，抓完再整個畫面重畫一次，讓使用者不用每次切分頁都空等。
async function ensureResourceLoaded(resource) {
  if (loadedResources[resource]) return;
  var cached = cacheGet(resource);
  if (cached) {
    RESOURCE_APPLIERS[resource](cached);
    setSyncStatus('loading', '背景更新中...');
    RESOURCE_FETCHERS[resource]().then(function(){
      var now=new Date();
      setSyncStatus('ok', '已同步 '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0'));
      renderAll();
    }).catch(function(e){
      setSyncStatus('error', '背景更新失敗');
    });
    return; // 不等待網路，讓呼叫端直接用快取資料繼續渲染
  }
  setSyncStatus('loading', '載入中...');
  try {
    await RESOURCE_FETCHERS[resource]();
    var now=new Date();
    setSyncStatus('ok', '已同步 '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0'));
  } catch(e) {
    setSyncStatus('error', '載入失敗');
    showToast('❌ 載入失敗：'+e.message);
  }
}

// 重新整理／每次寫入動作後呼叫：只重新抓「目前已經載入過」的資源，不會把還沒打開過的畫面也一起讀進來
async function fetchData() {
  setSyncStatus('loading', '資料載入中...');
  try {
    var tasks = [fetchCoreData()];
    if (loadedResources.headcount) tasks.push(fetchHeadcountData());
    if (loadedResources.salary) tasks.push(fetchSalaryData());
    if (loadedResources.scheduling) tasks.push(fetchSchedulingData());
    if (loadedResources.permissions) tasks.push(fetchPermissionData());
    await Promise.all(tasks);
    var now=new Date();
    setSyncStatus('ok', '已同步 '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0'));
    document.getElementById('errorBanner').style.display='none';
    initDateFilterSlots();
    renderAll();
  } catch(e) {
    setSyncStatus('error', '同步失敗');
    var eb=document.getElementById('errorBanner');
    eb.style.display='block'; eb.textContent='無法讀取資料：'+e.message;
  }
}

var TAB_RESOURCES = {
  kanban:['core'], candidateSearch:['core'], overview:['core'], trends:['core','headcount'],
  hc:['headcount'], salary:['salary'], schedule:['core','scheduling'], maintain:['core'],
  permissions:['permissions']
};

function renderAll(){
  if (loadedResources.core) {
    renderKanban();
    renderCandidateSearch();
    renderOverview();
  }
  if (currentTab === 'maintain') {
    if (maintainSheet === 'Candidate Records') renderCandQuery();
    else if (loadedResources.headcount) renderMaintain();
  }
  if (currentTab === 'schedule' && loadedResources.scheduling) renderSchedule();
  if (currentTab === 'salary' && loadedResources.salary) renderSalaryScreen();
  if (currentTab === 'permissions' && loadedResources.permissions) renderPermissions();
  if (loadedResources.headcount) renderHeadcount();
}

// ---- role selection ----
var ALL_VIEW_TABS = ['kanban','candidateSearch','overview','hc','maintain','trends','schedule','salary','permissions'];
// 「快速查看」模式：從身分選擇畫面左側直接進入單一分頁（等同管理者權限，但畫面上只看得到這一個分頁、沒有其他分頁與分頁列）
var restrictedSingleTab = null;

// 實際進入主畫面的共用邏輯：管理者（selectRole('manager')）、一般 HR（selectHRIdentity）、快速查看（enterQuickAccess）都會走這裡。
// roleToken 決定分頁顯示（recruiter/bp/manager）；hrName 是顯示用的識別名稱；units 是這個身分能看到的「單位」清單（null=不限制）。
function enterAs(roleToken, hrName, units) {
  userRole = roleToken;
  isAdmin = (roleToken === 'manager');
  currentHRName = hrName;
  currentHRUnits = units;
  candMaintenanceDateCleared = false; // 每次切換身分都重新開始，Candidate 畫面回到「還沒篩選」的初始狀態

  // 切換身分時回到頁首，確保上方分頁導覽會立即出現在視窗中。
  window.scrollTo(0, 0);
  document.getElementById('roleScreen').style.display = 'none';
  document.getElementById('mainAppWrapper').style.display = '';

  var badge = document.getElementById('identityBadge');
  if (badge) {
    badge.textContent = hrName ? ('👤 ' + hrName + (isAdmin ? '' : '（' + (roleToken==='bp'?'BP':'Recruiter') + '）')) : '';
  }

  var tabBar = document.querySelector('.tab-bar');

  if (restrictedSingleTab) {
    // 快速查看模式：隱藏整條分頁列，只顯示指定的那一個畫面
    if (tabBar) tabBar.style.display = 'none';
    document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
    currentTab = restrictedSingleTab;
    ALL_VIEW_TABS.forEach(function(v){
      document.getElementById('view-'+v).style.display = v===currentTab ? '' : 'none';
    });
  } else {
    if (tabBar) tabBar.style.display = '';
    // 依角色顯示/隱藏 tab
    document.querySelectorAll('.tab[data-tab-role]').forEach(function(t){
      var r = t.getAttribute('data-tab-role');
      t.style.display = r.split(',').indexOf(roleToken) >= 0 ? '' : 'none';
    });

    // 每次選擇身分都重設到第一個 tab，避免殘留前一個角色的畫面狀態
    var firstTab = Array.prototype.find.call(document.querySelectorAll('.tab[data-tab-role]'), function(t){
      return t.getAttribute('data-tab-role').split(',').indexOf(roleToken) >= 0;
    });
    document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
    if (firstTab) {
      firstTab.classList.add('active');
      var onclickAttr = firstTab.getAttribute('onclick');
      var match = onclickAttr.match(/switchTab\('(\w+)'/);
      if (match) {
        currentTab = match[1];
        ALL_VIEW_TABS.forEach(function(v){
          document.getElementById('view-'+v).style.display = v===currentTab ? '' : 'none';
        });
      }
    }
  }

  // 每次選擇身分都重新開始一份分頁瀏覽歷史（上一步／下一步）
  tabHistoryStack = [currentTab];
  tabHistoryIndex = 0;
  initTabHistoryNav();

  fetchCoreData().then(function(){
    if (!isAdmin && currentHRUnits && !currentHRUnits.length) {
      showToast('⚠️ 你目前尚未被指派任何單位，請聯繫管理者設定權限');
    }
    var resources = TAB_RESOURCES[currentTab] || ['core'];
    return Promise.all(resources.filter(function(r){return r!=='core';}).map(ensureResourceLoaded));
  }).then(function(){
    var now=new Date();
    setSyncStatus('ok', '已同步 '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0'));
    initDateFilterSlots();
    renderAll();
  }).catch(function(e){
    setSyncStatus('error', '同步失敗');
    var eb=document.getElementById('errorBanner');
    eb.style.display='block'; eb.textContent='無法讀取資料：'+e.message;
  });
}

// 「我是管理者」：不限制單位，可看到全部畫面（含權限管理）
// 「我是BP」／「我是Recruiter」：不指定特定的人，不限制單位（可看到全部單位的資料），
// 但分頁跟一般 HR 一樣依角色決定（BP／Recruiter 看得到的分頁不同），方便不想（或不用）挑自己名字的人快速進入。
function selectRole(role) {
  restrictedSingleTab = null;
  var displayName = role === 'manager' ? '管理者' : role === 'bp' ? 'BP' : role === 'recruiter' ? 'Recruiter' : role;
  enterAs(role, displayName, null);
}

// 一般 HR 點選「我是 XXX」：依 HR Directory 的角色決定看得到哪些分頁，依 Unit HR Mapping 決定看得到哪些單位的資料
function selectHRIdentity(name) {
  restrictedSingleTab = null;
  var entry = hrDirectoryData.find(function(h){ return h['HR姓名'] === name; });
  var roleToken = (entry && entry['角色'] === 'BP') ? 'bp' : 'recruiter';
  var units = getUnitsForHR(name);
  enterAs(roleToken, name, units);
}

// 身分選擇畫面左側「快速查看」：不用選身分，直接進入 Headcount Overview 或 Market Salary Records，
// 權限等同管理者（不限制單位），但畫面上只顯示這一個分頁，沒有其他分頁與分頁列。
function enterQuickAccess(tab) {
  restrictedSingleTab = tab;
  enterAs('manager', '管理者', null);
}

function switchRole() {
  userRole = null;
  isAdmin = false;
  currentHRName = null;
  currentHRUnits = null;
  restrictedSingleTab = null;
  window.scrollTo(0, 0);
  document.getElementById('mainAppWrapper').style.display = 'none';
  document.getElementById('roleScreen').style.display = 'flex';
  var tabBar = document.querySelector('.tab-bar');
  if (tabBar) tabBar.style.display = '';
  var badge = document.getElementById('identityBadge');
  if (badge) badge.textContent = '';
  // 回到身分選擇畫面時重新抓一次 HR 名冊，避免管理者剛在權限管理新增完 HR 卻看不到新按鈕
  fetchIdentityData();
}

// ---- 分頁瀏覽歷史（上一步／下一步）----
var tabHistoryStack = [];
var tabHistoryIndex = -1;

function findTabNavEl(tab) {
  return Array.prototype.find.call(document.querySelectorAll('.tab-bar:first-of-type > .tab'), function(t){
    var oc = t.getAttribute('onclick') || '';
    return oc.indexOf("switchTab('"+tab+"'") >= 0;
  });
}

function updateTabHistoryButtons() {
  document.querySelectorAll('.tab-history-back').forEach(function(b){ b.disabled = tabHistoryIndex <= 0; });
  document.querySelectorAll('.tab-history-forward').forEach(function(b){ b.disabled = tabHistoryIndex >= tabHistoryStack.length - 1; });
}

async function goToHistoryTab() {
  var tab = tabHistoryStack[tabHistoryIndex];
  if (!tab) return;
  var el = findTabNavEl(tab);
  window._navigatingTabHistory = true;
  await switchTab(tab, el);
  window._navigatingTabHistory = false;
  updateTabHistoryButtons();
}
function goTabHistoryBack() {
  if (tabHistoryIndex <= 0) return;
  tabHistoryIndex--;
  goToHistoryTab();
}
function goTabHistoryForward() {
  if (tabHistoryIndex >= tabHistoryStack.length - 1) return;
  tabHistoryIndex++;
  goToHistoryTab();
}

// 在每個畫面的大標題下方插入「上一步／下一步」導覽按鈕（只插入一次，避免重複）
function initTabHistoryNav() {
  document.querySelectorAll('[id^="view-"] .page-title').forEach(function(titleEl){
    var viewEl = titleEl.closest('[id^="view-"]');
    if (viewEl && viewEl.id === 'view-trends') return; // Recruitment Status 畫面不顯示上一步／下一步
    var next = titleEl.nextElementSibling;
    if (next && next.classList && next.classList.contains('tab-history-nav')) return;
    var nav = document.createElement('div');
    nav.className = 'tab-history-nav';
    nav.style.cssText = 'display:flex;gap:8px;margin:8px 0 4px;';
    nav.innerHTML =
      '<button class="btn-cancel tab-history-back" style="padding:4px 12px;font-size:12px;" onclick="goTabHistoryBack()">← 上一步</button>'+
      '<button class="btn-cancel tab-history-forward" style="padding:4px 12px;font-size:12px;" onclick="goTabHistoryForward()">下一步 →</button>';
    titleEl.insertAdjacentElement('afterend', nav);
  });
  updateTabHistoryButtons();
}

// ---- tabs ----
async function switchTab(tab,el) {
  // 記錄瀏覽歷史；若是透過上一步／下一步觸發，就不要再往歷史紀錄裡新增，也不要砍掉「未來」的紀錄
  if (!window._navigatingTabHistory) {
    tabHistoryStack = tabHistoryStack.slice(0, tabHistoryIndex + 1);
    tabHistoryStack.push(tab);
    tabHistoryIndex = tabHistoryStack.length - 1;
    updateTabHistoryButtons();
  }

  currentTab=tab;
  window.scrollTo(0, 0);
  document.querySelectorAll('.tab-bar:first-of-type > .tab').forEach(function(t){t.classList.remove('active');});
  if (el) el.classList.add('active');
  ALL_VIEW_TABS.forEach(function(v){
    document.getElementById('view-'+v).style.display=v===tab?'':'none';
  });

  var resources = TAB_RESOURCES[tab] || [];
  for (var i=0;i<resources.length;i++) { await ensureResourceLoaded(resources[i]); }
  if (tab === 'maintain' && maintainSheet === 'Headcount Records') { await ensureResourceLoaded('headcount'); }

  if (tab === 'maintain') {
    if (maintainSheet === 'Candidate Records') { ensureNewCandidateFieldsRendered(); renderCandQuery(); }
    else renderMaintain();
  }
  if (tab === 'kanban') renderKanban();
  if (tab === 'candidateSearch') renderCandidateSearch();
  if (tab === 'overview') renderOverview();
  if (tab === 'hc') renderHeadcount();
  if (tab === 'trends') renderTrends();
  if (tab === 'schedule') renderSchedule();
  if (tab === 'salary') { ensureNewSalaryFieldsRendered(); renderSalaryScreen(); }
  if (tab === 'permissions') renderPermissions();
}

// ---- filter helpers ----
function toggleFilter(stage){activeFilter=activeFilter===stage?null:stage;renderOverview();}
function toggleCollapse(type){
  var body=document.getElementById('cb-'+type), arrow=document.getElementById('ca-'+type);
  body.classList.toggle('open'); arrow.classList.toggle('open');
}

// 依 電訪/面試/錄取 三個階段組出 Kanban 看板 HTML（Candidate Overview、Candidate Search 共用）
// readOnly=true 時卡片點開後只能查看、不能編輯（給 Candidate Search 用）
function buildKanbanPhasesHtml(filtered, readOnly, hideManagerInvitationStage) {
  var clickFn = readOnly ? 'handleCardClickReadOnly' : 'handleCardClick';
  var phases=[
    {label:'電訪階段', cls:'phase-phone', stages:hideManagerInvitationStage ? CANDIDATE_OVERVIEW_PHONE_STAGES : PHONE_STAGES},
    {label:'面試階段', cls:'phase-interview', stages:INTERVIEW_STAGES},
    {label:'錄取階段', cls:'phase-offer', stages:OFFER_STAGES},
    {label:'其他', cls:'phase-other', stages:OTHER_STAGES}
  ];

  var boardHtml='';
  phases.forEach(function(phase, pi){
    boardHtml+='<div class="kanban-phase '+phase.cls+'">';
    boardHtml+='<div style="margin-bottom:10px"><div class="kanban-phase-label">'+phase.label+'</div><div style="display:flex;gap:10px;">';
    phase.stages.forEach(function(stage){
      var cands=filtered.filter(function(d){return d.Result===stage;});
      cands.sort(function(a,b){return getSortTs(a)-getSortTs(b);});
      var cards=cands.length===0?'<div class="kanban-empty">無人選</div>':
        cands.map(function(d){
          var t=(stage==='待電訪'||stage==='排電訪')?(d.Interview_date||d['Phone Interview_date']||''):(d.Interview_date||'');
          var timeStr=fmtDate(t);
          var tagsHtml = '';
          if (kbCardDisplayFields['Job Function']) tagsHtml += '<span class="kanban-card-pos '+jfClass(d['Job Function'])+'">'+(d['Job Function']||'')+'</span>';
          if (kbCardDisplayFields['單位']) tagsHtml += '<span class="kanban-card-bu">'+(d['單位']||'')+'</span>';
          var extraLinesHtml = '';
          if (kbCardDisplayFields['Inviter'] && d.Inviter) extraLinesHtml += '<div class="kanban-card-extra">👤 '+d.Inviter+'</div>';
          if (kbCardDisplayFields['Phone Interview_date'] && d['Phone Interview_date']) extraLinesHtml += '<div class="kanban-card-extra">📞 '+fmtDate(d['Phone Interview_date'])+'</div>';
          if (kbCardDisplayFields['Interview_date'] && d.Interview_date) extraLinesHtml += '<div class="kanban-card-extra">🗓 '+fmtDate(d.Interview_date)+'</div>';
          // 用人選在試算表裡實際的列號（_row）而不是目前陣列位置（idx）來綁定卡片，
          // 陣列位置在背景重新整理資料後可能會變動（例如有人被刪除／新增，順序位移），
          // 若卡片還沒重畫就被點擊，用 idx 反查有可能對到完全不同的人選；_row 是穩定不變的識別碼，才不會點錯人。
          return '<div class="kanban-card" data-row="'+d._row+'" data-stage="'+stage+'" onclick="'+clickFn+'(this)">'
            +'<div class="kanban-card-row1">'
              +'<div class="kanban-card-name">'+d.Name+'</div>'
              +'<div class="kanban-card-right">'+tagsHtml+'</div>'
            +'</div>'
            +(timeStr?'<div class="kanban-card-time">🕐 '+timeStr+'</div>':'')
            +extraLinesHtml
            +'</div>';
        }).join('');
      boardHtml+='<div class="kanban-col">'
        +'<div class="kanban-col-hdr"><span>'+stage+'</span><span class="kanban-col-count">'+cands.length+'</span></div>'
        +'<div class="kanban-cards">'+cards+'</div>'
        +'</div>';
    });
    boardHtml+='</div></div>';
    if(pi<phases.length-1) boardHtml+='<div class="kanban-phase-divider"></div>';
  });
  return boardHtml;
}

// Candidate Overview 看板卡片「顯示資料」：可勾選要不要顯示 單位／Job Function／Inviter／Interview_date／Phone Interview_date
var KB_CARD_FIELD_OPTIONS = ['單位', 'Job Function', 'Inviter', 'Interview_date', 'Phone Interview_date'];
var kbCardDisplayFields = {'單位': true, 'Job Function': true, 'Inviter': false, 'Interview_date': false, 'Phone Interview_date': false};

function toggleKbCardField(field) {
  kbCardDisplayFields[field] = !kbCardDisplayFields[field];
  renderKbCardFieldsDropdown();
  renderKanban();
}

function renderKbCardFieldsDropdown() {
  var el = document.getElementById('kbCardFieldsSlot');
  if (!el) return;
  var isOpen = !!msDropdownOpenState['kbCardFieldsSlot'];
  var selectedCount = KB_CARD_FIELD_OPTIONS.filter(function(f){ return kbCardDisplayFields[f]; }).length;
  var summary = selectedCount + ' 項';
  var optionsHtml = KB_CARD_FIELD_OPTIONS.map(function(f){
    var checked = kbCardDisplayFields[f];
    return '<label class="ms-dropdown-option"><input type="checkbox" '+(checked?'checked':'')+' onchange="toggleKbCardField(\''+f+'\')"> '+f+'</label>';
  }).join('');
  el.className = 'ms-dropdown';
  el.innerHTML =
    '<button type="button" class="ms-dropdown-toggle" onclick="toggleMsDropdownPanel(\'kbCardFieldsSlot\')">顯示資料：'+summary+' <span class="ms-dropdown-caret">▾</span></button>'+
    '<div class="ms-dropdown-panel" id="kbCardFieldsSlot-panel" style="display:'+(isOpen?'block':'none')+';">'+
      optionsHtml+
    '</div>';
}

// ---- KANBAN ----
function renderKanban() {
  var now=new Date(); now.setHours(0,0,0,0);

  var kbBuOptions = [...new Set(allData.map(function(d){return String(d['單位']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('kbBuBar', 'kb-bu', kbBuOptions);
  var kbJobOptions = buildMultiValueOptions(allData, function(d){return d['Job Function'];});
  renderMultiFilterBar('kbJobBar', 'kb-job', kbJobOptions);
  renderKbCardFieldsDropdown();

  var filtered=allData.filter(function(d){
    if(!multiFilterPass('kb-bu', d['單位'])) return false;
    if(!multiFilterPassMulti('kb-job', d['Job Function'])) return false;
    if(!dateFilterPass('kanban', d)) return false;
    // 超過7天未回覆不顯示
    if(d.Result==='104已邀約未回覆') {
      var inviteDate=parseDateTime(d.invite_date||d['invite date']||'');
      if(!inviteDate) return false;
      var diff=(now-inviteDate)/(1000*60*60*24);
      if(diff>7) return false;
    }
    return true;
  });

  document.getElementById('kanbanBoard').innerHTML = buildKanbanPhasesHtml(filtered, false, true);
}

// ---- CANDIDATE SEARCH ----
// 搜尋 + 目前狀態篩選 + 時間篩選（僅 invite_date／Interview_date）＋ 電訪/面試/錄取階段 Kanban
function renderCandidateSearch() {
  var search=(document.getElementById('csSearch')?document.getElementById('csSearch').value:'').toLowerCase();
  var searchTerms = splitSearchTerms(search);

  renderMultiFilterDropdown('csResultBar', 'cs-result', getResultOptions(), '目前狀態');

  var filtered=allData.filter(function(d){
    if(!multiFilterPass('cs-result', d.Result)) return false;
    if(searchTerms.length){
      var resumeKey = findResumeCodeKey(d);
      if(!matchesAnySearchTerm(d.Name, searchTerms) && !matchesAnySearchTerm(d[resumeKey], searchTerms)) return false;
    }
    if(!dateFilterPass('candidateSearch', d)) return false;
    return true;
  });

  document.getElementById('csKanbanBoard').innerHTML = buildKanbanPhasesHtml(filtered, true);
}

// ---- Modal ----
// 直接用卡片上的 data-row（試算表列號，穩定不變）開啟編輯視窗，不要再透過陣列位置（data-idx）反查——
// 陣列位置在背景重新整理資料後可能會變動，用它反查有可能點到別人的資料。
function handleCardClick(el) {
  var row = parseInt(el.getAttribute('data-row'));
  if (!row) return;
  openEditCandidateModal(row);
}

// Candidate Search 專用：卡片點開後僅供查看，不能編輯
function handleCardClickReadOnly(el) {
  var row = parseInt(el.getAttribute('data-row'));
  if (!row) return;
  openViewCandidateModal(row);
}

function renderReadOnlyField(rec, field) {
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0;
  var displayVal = isDateOnlyField ? fmtDateOnly(rawVal) : isDateField ? fmtDate(rawVal) : rawVal;
  var safe = (displayVal||'—').toString().replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<div><div style="font-size:10px;font-weight:600;color:var(--text-tertiary);margin-bottom:4px;">'+field+'</div>'
    +'<div style="font-size:13px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);min-height:18px;white-space:pre-wrap;word-break:break-word;">'+safe+'</div></div>';
}

function openViewCandidateModal(row) {
  var cand = allData.find(function(d){ return d._row === row; });
  if (!cand) { showToast('找不到這位人選的資料'); return; }
  var candHeaders = filterCandHeadersForRole(maintainHeaders['Candidate Records'] || Object.keys(cand).filter(function(k){return k!=='_row';}));
  document.getElementById('viewCandModalName').textContent = cand.Name || '人選資料';
  document.getElementById('viewCandModalFields').innerHTML = candHeaders.map(function(h){
    return renderReadOnlyField(cand, h);
  }).join('');
  document.getElementById('viewCandidateModal').style.display = 'flex';
}

function closeViewCandidateModal() {
  document.getElementById('viewCandidateModal').style.display = 'none';
}

function openModal(row, name, pos, bu, currentStage) {
  selectedCard={row:row, name:name, pos:pos, bu:bu, currentStage:currentStage};
  document.getElementById('modalName').textContent=name;
  document.getElementById('modalSub').textContent=bu+' · '+pos+' · 目前：'+currentStage;

  var phases=[
    {label:'電訪階段', stages:PHONE_STAGES},
    {label:'面試階段', stages:INTERVIEW_STAGES},
    {label:'錄取階段', stages:OFFER_STAGES},
    {label:'其他', stages:OTHER_STAGES},
    {label:'⬇️ 結束/不推進', stages:COLLAPSE_STAGES}
  ];
  // 試算表裡若有新增、但不在上面五個分類中的 Result 選項，歸到「未分類」，確保都能被選到
  var knownStages = PHONE_STAGES.concat(INTERVIEW_STAGES, OFFER_STAGES, OTHER_STAGES, COLLAPSE_STAGES);
  var otherStages = getResultOptions().filter(function(s){ return knownStages.indexOf(s) < 0; });
  if (otherStages.length) phases.push({label:'未分類', stages:otherStages});
  var html='';
  phases.forEach(function(phase){
    html+='<div class="modal-stage-group"><div class="modal-stage-group-title">'+phase.label+'</div><div class="modal-stages">';
    phase.stages.forEach(function(s){
      var color=STAGE_COLORS[s]||'#9CA3AF';
      html+='<button class="stage-btn'+(s===currentStage?' current':'')+'" onclick="changeStage(\''+s+'\')" style="'+(s===currentStage?'border-color:'+color+';background:'+color+'18;':'')+'">'
        +'<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+color+';margin-right:6px;vertical-align:middle"></span>'+s+'</button>';
    });
    html+='</div></div>';
  });
  document.getElementById('modalStages').innerHTML=html;
  document.getElementById('modal').style.display='flex';
}

function closeModal(){document.getElementById('modal').style.display='none';selectedCard=null;}

function openFullEditFromStageModal() {
  if (!selectedCard) return;
  var row = selectedCard.row;
  closeModal();
  openEditCandidateModal(row);
}

function openEditCandidateModal(row) {
  var cand = allData.find(function(d){ return d._row === row; });
  if (!cand) { showToast('找不到這位人選的資料'); return; }
  var idx = allData.indexOf(cand);
  var candHeaders = filterCandHeadersForMaintenance(maintainHeaders['Candidate Records'] || Object.keys(cand).filter(function(k){return k!=='_row';}));

  // 排版比照 Candidate 畫面查詢人選資料卡：Phone Interview Record (HR)/(主管) 並排、Memo 全寬、104_Position 加寬
  var isPhoneRecordHeader = function(h){ return /phone\s*interview\s*record/i.test(h); };
  var phoneRecordFields = candHeaders.filter(isPhoneRecordHeader).sort(function(a,b){
    return (/hr/i.test(a)?0:1) - (/hr/i.test(b)?0:1); // HR 固定在左，主管固定在右
  });
  var pairedPhoneRecordDone = false;
  var fieldsHtml = candHeaders.map(function(h){
    if (isPhoneRecordHeader(h)) {
      if (pairedPhoneRecordDone) return '';
      pairedPhoneRecordDone = true;
      if (phoneRecordFields.length >= 2) {
        var pairHtml = phoneRecordFields.map(function(pf){
          return renderQueryField('Candidate Records', cand, pf, idx, false, true);
        }).join('');
        return '<div style="grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:14px;">'+pairHtml+'</div>';
      }
      return renderQueryField('Candidate Records', cand, h, idx, true, true);
    }
    var isFullWidth = h.indexOf('Memo') >= 0;
    var isWide = h === '104_Position';
    return renderQueryField('Candidate Records', cand, h, idx, isFullWidth ? true : (isWide ? 'span2' : false), true);
  }).join('');

  document.getElementById('editCandModalName').textContent = cand.Name || '編輯人選資料';
  document.getElementById('editCandModalFields').innerHTML = fieldsHtml;
  document.getElementById('editCandidateModal').style.display = 'flex';
  document.getElementById('editCandModalFields').querySelectorAll('textarea:not(.ta-scrollable)').forEach(autoGrowTextarea);
}

function closeEditCandidateModal() {
  document.getElementById('editCandidateModal').style.display = 'none';
  renderAll();
}

async function changeStage(newStage) {
  if (!selectedCard) return;
  if (newStage===selectedCard.currentStage){closeModal();return;}
  // 先儲存再關 modal，避免 selectedCard 被清空
  var card = {row:selectedCard.row, name:selectedCard.name};
  closeModal();
  showToast('更新中...');
  try {
    var payload = {row:card.row, result:newStage};
    console.log('Sending:', JSON.stringify(payload));
    // 用 GET + URL 參數，no-cors 模式，Apps Script 用 doGet 處理寫入
    var url = APPS_SCRIPT_URL + '?action=update&row=' + encodeURIComponent(card.row) + '&result=' + encodeURIComponent(newStage);
    var res=await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    console.log('Response status:', res.status, res.type);
    showToast('✓ 已更新：'+card.name+' → '+newStage);
    var d=allData.find(function(x){return x._row===card.row;});
    if(d) { d.Result=newStage; d['Result Update_date'] = getTodayDateStr(); }
    renderAll();
  } catch(e) {
    showToast('❌ 更新失敗：'+e.message);
  }
}

// ---- OVERVIEW ----
function renderOverview() {
  var search=(document.getElementById('ovSearch')?document.getElementById('ovSearch').value:'').toLowerCase();
  var searchTerms = splitSearchTerms(search);

  var ovBuOptions = [...new Set(allData.map(function(d){return String(d['單位']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('ovBuBar', 'ov-bu', ovBuOptions);
  var ovJobOptions = buildMultiValueOptions(allData, function(d){return d['Job Function'];});
  renderMultiFilterBar('ovJobBar', 'ov-job', ovJobOptions);

  var filtered=allData.filter(function(d){
    return multiFilterPass('ov-bu', d['單位']) &&
           multiFilterPassMulti('ov-job', d['Job Function']) &&
           (!searchTerms.length||matchesAnySearchTerm(d.Name, searchTerms)) &&
           dateFilterPass('overview', d);
  });
  var activeStages=['排電訪','待電訪','排面試','待面試'];
  document.getElementById('overviewSub').textContent='共 '+filtered.length+' 筆人選資料';
  var timeCls={'排電訪':'t-amber','待電訪':'t-teal','排面試':'t-blue','待面試':'t-purple'};
  var timeIcon={'排電訪':'📅','待電訪':'📞','排面試':'📅','待面試':'🗣️'};
  var timeLabel={'排電訪':'可排電訪時段','待電訪':'電訪時間','排面試':'可排面試時段','待面試':'面試時間'};

  function makeCard(d,stage,cls,icon,label){
    var rawT=(stage==='待電訪'||stage==='排電訪')?(d.Interview_date||d['Phone Interview_date']||''):(d.Interview_date||'');
    var t=fmtDate(rawT);
    var th=t?'<div class="card-time '+(cls||'t-gray')+'"><span style="font-size:13px">'+(icon||'🕐')+'</span><div><div class="card-time-label">'+(label||'時間')+'</div><div style="font-size:11px;opacity:.85;margin-top:1px">'+t+'</div></div></div>':'<div class="card-time t-gray"><span style="font-size:13px">🕐</span><div><div class="card-time-label">尚未排定時間</div></div></div>';
    return '<div class="card"><div class="card-top"><div class="card-name">'+d.Name+'</div><div class="card-bu">'+d['單位']+'</div></div><div class="card-pos">'+(d['Job Function']||'')+(d.Source?' · '+d.Source:'')+'</div>'+th+'</div>';
  }

  activeStages.forEach(function(stage){
    var cands = filtered.filter(function(d){return d.Result===stage;});
    cands.sort(function(a,b){return getSortTs(a)-getSortTs(b);});
    document.getElementById('c-'+stage).textContent = cands.length;
    var listHtml = cands.length===0 ? '<div class="empty" style="padding:8px 0;">目前無人選</div>' :
      cands.map(function(d){return makeCard(d,stage,timeCls[stage],timeIcon[stage],timeLabel[stage]);}).join('');
    document.getElementById('list-'+stage).innerHTML = listHtml;
  });

  var dp=filtered.filter(function(d){return (d.Result==='待電訪'||d.Result==='排電訪')&&isDonePhone(d);});
  dp.sort(function(a,b){return getSortTs(b)-getSortTs(a);});
  document.getElementById('cc-phone').textContent=dp.length+' 人';
  document.getElementById('cg-phone').innerHTML=dp.length===0?'<div class="empty">無資料</div>':'<div class="collapse-grid">'+dp.map(function(d){return makeCard(d,'待電訪','t-gray','📞','電訪時間');}).join('')+'</div>';
  var di=filtered.filter(function(d){return (d.Result==='待面試'||d.Result==='排面試')&&isDoneInterview(d);});
  di.sort(function(a,b){return getSortTs(b)-getSortTs(a);});
  document.getElementById('cc-interview').textContent=di.length+' 人';
  document.getElementById('cg-interview').innerHTML=di.length===0?'<div class="empty">無資料</div>':'<div class="collapse-grid">'+di.map(function(d){return makeCard(d,'待面試','t-gray','🗣️','面試時間');}).join('')+'</div>';
}

// 這些欄位原本只存在 Phone Interview 工作表、且不開放 BP 角色看到；欄位併入 Candidate Records 後，
// 任何會把 Candidate Records 欄位顯示給人選看的地方（編輯/查看 modal、新增表單等）都要套用這個過濾，維持原本的權限規則
var BP_HIDDEN_CAND_FIELDS = ['離職原因','工作/實習&過往經驗','求職狀態','現有待遇','期望待遇','其他資訊','是否邀約'];
function filterCandHeadersForRole(headers) {
  if (userRole !== 'bp') return headers;
  return headers.filter(function(h){ return BP_HIDDEN_CAND_FIELDS.indexOf(h) < 0; });
}
// 人選資料維護與查詢畫面專用：這兩個是系統自動寫入的排程紀錄欄位（填 Phone Interview_date／Interview_date 時會自動同步），
// 只是不需要在這個畫面顯示，後端 onEdit／editCell 的自動更新邏輯完全不受影響，資料還是照樣會被寫入試算表；
// Candidate Overview 的看板卡片／檢視編輯彈窗不受影響，一樣會顯示。
var MAINTAIN_QUERY_HIDDEN_FIELDS = ['Phone Interview Scheduled', 'Interview Scheduled', 'Hired date', '離職原因', '工作/實習&過往經驗', '求職狀態', '現有待遇', '期望待遇', '其他資訊', 'HR Comment'];
function filterCandHeadersForMaintenance(headers) {
  return filterCandHeadersForRole(headers).filter(function(h){ return MAINTAIN_QUERY_HIDDEN_FIELDS.indexOf(h) < 0; });
}

// 這些欄位原本是 Phone Interview 工作表裡內容較長的文字欄位，併入 Candidate Records 後在查詢卡裡也給較寬的顯示空間
var CAND_LONG_TEXT_FIELDS = ['工作/實習&過往經驗','求職狀態','現有待遇','期望待遇','其他資訊'];

// 可重複使用的「表格用」欄位輸入元件：下拉選單用 select，其餘用可編輯文字格，統一走 commitMaintain* 寫回試算表
// 共用元件：下拉選單 + 可手動輸入新值（用 input+datalist，而不是 select，這樣既能選也能自己打新的值）
// 點進欄位時會先清空顯示，確保瀏覽器一定顯示完整選單（否則已有值時瀏覽器常常只會比對開頭文字，選單會顯示不全）
var _dlIdCounter = 0;
function buildDropdownDatalistInput(sheetName, rec, field, col, idx, options, inputStyle) {
  var dlId = 'dl_' + (_dlIdCounter++);
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');
  var optHtml = options.map(function(o){ return '<option value="'+String(o).replace(/"/g,'&quot;')+'">'; }).join('');
  return '<input type="text" list="'+dlId+'" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" value="'+rawSafe+'" '+
    'onfocus="dlInputFocus(this)" onchange="commitMaintainInputList(this)" onblur="commitMaintainInputList(this)" style="'+inputStyle+'">'+
    '<datalist id="'+dlId+'">'+optHtml+'</datalist>';
}

// ===== 日期欄位小月曆選擇器（invite_date／Phone Interview_date／Interview_date／Result Update_date／Onboard date）=====
// 欄位本身還是一般文字輸入框（可以手動打字，例如自己補上時間），只是額外多一顆月曆圖示，
// 點下去會跳出小月曆，點選日期後直接把「YYYY/MM/DD」部分換掉（原本欄位裡日期後面的文字，例如時間，會保留），並自動存檔。
function buildDateFieldInput(sheetName, rec, field, col, idx, displayVal, rawSafe) {
  var uid = 'dtf_' + (_dlIdCounter++);
  var dispSafe = String(displayVal||'').replace(/"/g,'&quot;');
  return '<div class="date-field-wrap">'+
    '<input type="text" id="'+uid+'" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" value="'+dispSafe+'" autocomplete="off" '+
      'onfocus="enterMaintainEditTA(this)" onblur="commitMaintainCellTA(this)" '+
      'style="width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);box-sizing:border-box;">'+
    '<button type="button" class="date-field-cal-btn" title="選擇日期" onmousedown="event.preventDefault()" onclick="openMiniDatePicker(document.getElementById(\''+uid+'\'))">📅</button>'+
  '</div>';
}

// 從日期欄位目前的值拆出「年/月/日」與後面的文字（例如時間、上午下午、整天等），
// 用來初始化小月曆要顯示哪個月份，以及選好日期後要把後面的文字接回去
function splitDateFieldValue(val) {
  var s = String(val||'').trim();
  var m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s*(.*)$/);
  if (m) return { y: parseInt(m[1]), m: parseInt(m[2]), d: parseInt(m[3]), rest: m[4] || '' };
  return null;
}

var _minidpState = null; // {input, year, month, selectedDay, rest, needsTime, hour, minute}

// isDraft：新增人選表單用（欄位還沒存到試算表、也沒有 data-row），選完日期／時間只更新輸入框的值，
// 不會呼叫 commitMaintainCellTA 存檔，等使用者按「＋ 新增人選資料」送出時才會一起收集進去。
function openMiniDatePicker(inputEl, isDraft) {
  if (!inputEl) return;
  closeMiniDatePicker();
  var field = inputEl.getAttribute('data-field');
  var needsTime = (field === 'Phone Interview_date' || field === 'Interview_date');
  var parsed = splitDateFieldValue(inputEl.value);
  var hour = 9, minute = 0;
  if (parsed && needsTime) {
    var tm = String(parsed.rest||'').match(/(\d{1,2}):(\d{2})/);
    if (tm) { hour = parseInt(tm[1]); minute = parseInt(tm[2]); }
  }
  if (!parsed) {
    var t = new Date();
    parsed = { y: t.getFullYear(), m: t.getMonth()+1, d: t.getDate(), rest: '' };
    if (needsTime) { hour = t.getHours(); minute = Math.floor(t.getMinutes()/5)*5; }
  }
  _minidpState = { input: inputEl, year: parsed.y, month: parsed.m, selectedDay: parsed.d, rest: parsed.rest, needsTime: needsTime, hour: hour, minute: minute, isDraft: !!isDraft };

  // 外殼（上/下月按鈕、月份文字、星期標題列、日期格子容器、時間選單容器、底部按鈕）只在這裡建立一次；
  // 之後切換月份／選日期／改時間都只改裡面的內容（textContent／innerHTML 局部更新），
  // 「‹」「›」這些按鈕本身絕對不會被整個換掉、跟頁面斷開，才不會被「點在面板外」的判斷誤判掉。
  var weekLabels = ['日','一','二','三','四','五','六'];
  var pop = document.createElement('div');
  pop.id = 'minidpPopup';
  pop.className = 'minidp-popup';
  pop.innerHTML = '<div class="minidp-header">'+
      '<button type="button" onmousedown="event.preventDefault()" onclick="changeMiniDatePickerMonth(-1)">‹</button>'+
      '<span id="minidpMonthLabel"></span>'+
      '<button type="button" onmousedown="event.preventDefault()" onclick="changeMiniDatePickerMonth(1)">›</button>'+
    '</div>'+
    '<div class="minidp-weekdays">'+weekLabels.map(function(w){return '<span>'+w+'</span>';}).join('')+'</div>'+
    '<div class="minidp-days" id="minidpDaysGrid"></div>'+
    '<div id="minidpTimeSlot"></div>'+
    '<div class="minidp-footer">'+
      '<button type="button" onmousedown="event.preventDefault()" onclick="selectMiniDatePickerToday()">今天</button>'+
      '<button type="button" onmousedown="event.preventDefault()" onclick="clearMiniDatePickerDate()">清除日期</button>'+
    '</div>';
  document.body.appendChild(pop);
  renderMiniDatePickerBody();
  var rect = inputEl.getBoundingClientRect();
  pop.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  pop.style.left = (window.scrollX + rect.left) + 'px';
  setTimeout(function(){ document.addEventListener('click', minidpOutsideClickHandler); }, 0);
}

function minidpOutsideClickHandler(e) {
  var pop = document.getElementById('minidpPopup');
  if (!pop) return;
  // 用 composedPath()（事件「原始」傳遞路徑）判斷，而不是直接用 e.target／pop.contains()：
  // 選日期／改時間時，日期格子跟時間選單那幾塊內容會重繪，剛剛點的元素可能因此跟頁面斷開，
  // 這時如果用「即時查詢父層」的方式判斷會誤判成「點在面板外」，導致面板被提早關掉。
  var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (_minidpState && path.indexOf(_minidpState.input) >= 0) return;
  if (path.indexOf(pop) >= 0) return;
  closeMiniDatePicker(true); // 點旁邊空白處才視為「選完了」，這時候才真正存檔
}

function closeMiniDatePicker(shouldSave) {
  // Phone Interview_date／Interview_date 需要日期＋時間都選完才算完整，中途（例如剛選完日期、還沒選時間）
  // 存檔的話會存到不完整的值；改成只有真的要關閉面板（點旁邊空白處）時才把目前選到的日期＋時間存檔。
  if (shouldSave && _minidpState && _minidpState.needsTime && !_minidpState.isDraft) {
    commitMaintainCellTA(_minidpState.input);
  }
  var pop = document.getElementById('minidpPopup');
  if (pop) pop.remove();
  document.removeEventListener('click', minidpOutsideClickHandler);
  _minidpState = null;
}

function changeMiniDatePickerMonth(delta) {
  if (!_minidpState) return;
  var m = _minidpState.month + delta, y = _minidpState.year;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  _minidpState.month = m; _minidpState.year = y;
  renderMiniDatePickerBody();
}

function renderMiniDatePickerBody() {
  var pop = document.getElementById('minidpPopup');
  if (!pop || !_minidpState) return;
  var y = _minidpState.year, m = _minidpState.month;
  var startWeekday = new Date(y, m-1, 1).getDay();
  var daysInMonth = new Date(y, m, 0).getDate();
  var today = new Date(); today.setHours(0,0,0,0);

  var monthLabel = document.getElementById('minidpMonthLabel');
  if (monthLabel) monthLabel.textContent = y+' 年 '+m+' 月';

  var daysHtml = '';
  for (var i=0;i<startWeekday;i++) daysHtml += '<span></span>';
  for (var d=1; d<=daysInMonth; d++) {
    var isToday = (y===today.getFullYear() && m===today.getMonth()+1 && d===today.getDate());
    var isSelected = (_minidpState.selectedDay===d);
    daysHtml += '<button type="button" class="minidp-day'+(isToday?' is-today':'')+(isSelected?' is-selected':'')+'" '+
      'onmousedown="event.preventDefault()" onclick="selectMiniDatePickerDate('+y+','+m+','+d+')">'+d+'</button>';
  }
  var daysGrid = document.getElementById('minidpDaysGrid');
  if (daysGrid) daysGrid.innerHTML = daysHtml;

  var timeSlot = document.getElementById('minidpTimeSlot');
  if (timeSlot) {
    if (_minidpState.needsTime) {
      var hourOpts = '';
      for (var h=0; h<24; h++) hourOpts += '<option value="'+h+'"'+(h===_minidpState.hour?' selected':'')+'>'+String(h).padStart(2,'0')+'</option>';
      var minuteOpts = '';
      for (var mi=0; mi<60; mi+=5) minuteOpts += '<option value="'+mi+'"'+(mi===_minidpState.minute?' selected':'')+'>'+String(mi).padStart(2,'0')+'</option>';
      timeSlot.innerHTML = '<div class="minidp-time-row">'+
        '<span class="minidp-time-label">時間</span>'+
        '<select id="minidpHour" onchange="updateMiniDatePickerTime()">'+hourOpts+'</select>'+
        '<span>:</span>'+
        '<select id="minidpMinute" onchange="updateMiniDatePickerTime()">'+minuteOpts+'</select>'+
      '</div>';
    } else {
      timeSlot.innerHTML = '';
    }
  }
}

// 組合目前選到的年/月/日（＋時間欄位的話再加上時:分）寫回輸入框；
// shouldSave 為 true 才會真的存檔——Phone Interview_date／Interview_date 要日期＋時間都選完，
// 點旁邊空白處關閉面板時才存檔，避免只選了日期、還沒選時間就先存到不完整的值。
function applyMiniDatePickerValue(shouldSave) {
  if (!_minidpState) return;
  var input = _minidpState.input;
  var dateStr = _minidpState.year+'/'+String(_minidpState.month).padStart(2,'0')+'/'+String(_minidpState.selectedDay).padStart(2,'0');
  var valueStr = _minidpState.needsTime
    ? dateStr+' '+String(_minidpState.hour).padStart(2,'0')+':'+String(_minidpState.minute).padStart(2,'0')
    : (_minidpState.rest ? dateStr+' '+_minidpState.rest : dateStr);
  input.value = valueStr;
  if (shouldSave && !_minidpState.isDraft) commitMaintainCellTA(input);
}

function selectMiniDatePickerDate(y, m, d) {
  if (!_minidpState) return;
  _minidpState.year = y; _minidpState.month = m; _minidpState.selectedDay = d;
  if (_minidpState.needsTime) {
    // Phone Interview_date／Interview_date：先只更新面板顯示，日期＋時間都選完、點旁邊空白處時才存檔
    applyMiniDatePickerValue(false);
    renderMiniDatePickerBody();
  } else {
    applyMiniDatePickerValue(true);
    closeMiniDatePicker();
  }
}

// Phone Interview_date／Interview_date 專用：調整時間下拉選單後先更新面板顯示，面板保持開啟，
// 等使用者點旁邊空白處關閉面板時（見 minidpOutsideClickHandler／closeMiniDatePicker）才真正存檔
function updateMiniDatePickerTime() {
  if (!_minidpState) return;
  var hEl = document.getElementById('minidpHour');
  var mEl = document.getElementById('minidpMinute');
  if (hEl) _minidpState.hour = parseInt(hEl.value);
  if (mEl) _minidpState.minute = parseInt(mEl.value);
  applyMiniDatePickerValue(false);
}

function selectMiniDatePickerToday() {
  var t = new Date();
  selectMiniDatePickerDate(t.getFullYear(), t.getMonth()+1, t.getDate());
}

function clearMiniDatePickerDate() {
  if (!_minidpState) return;
  var input = _minidpState.input;
  var isDraft = _minidpState.isDraft;
  input.value = '';
  closeMiniDatePicker(false);
  if (!isDraft) commitMaintainCellTA(input);
}

// 嚴格下拉選單欄位（Candidate Records）：只能從清單中選擇，不提供手動輸入
var STRICT_SELECT_FIELDS = ['Result', '最高學歷', '婉拒理由', '是否邀約'];

// 共用元件：嚴格下拉選單（<select>），用於已存檔的人選資料卡片，選擇後直接寫回試算表
function buildDropdownSelectInput(sheetName, rec, field, col, idx, options, inputStyle) {
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');
  var opts = options.slice();
  if (rawVal && opts.indexOf(rawVal) < 0) opts.unshift(rawVal);
  var optHtml = '<option value=""'+(rawVal?'':' selected')+'></option>' + opts.map(function(o){
    var sel = (String(o) === String(rawVal)) ? ' selected' : '';
    return '<option value="'+String(o).replace(/"/g,'&quot;')+'"'+sel+'>'+String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</option>';
  }).join('');
  var selectHtml = '<select data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
    'onchange="commitMaintainSelect(this)" style="'+inputStyle+'">'+optHtml+'</select>';
  if (!rawVal) return selectHtml;
  return '<div class="select-clear-wrap">'+selectHtml+
    '<button type="button" class="select-clear-btn" title="清除" onclick="clearDropdownSelectValue(this)">✕</button>'+
  '</div>';
}

function clearDropdownSelectValue(btn) {
  var sel = btn.previousElementSibling;
  if (!sel || sel.tagName !== 'SELECT') return;
  sel.value = '';
  commitMaintainSelect(sel);
}

// 這些欄位改成勾選式多選（同一格用「、」分隔存回試算表）：
// Inviter／面試主管 可能不只一位；單位、Job Function、104_Position、負責HR 則是希望用勾選取代手動打字，減少輸入不一致。
// 清單來源見 MAINTAIN_DROPDOWNS；勾選清單以外的值（例如舊資料、或用「新增」手動加入的新選項）也能維持顯示與勾選。
var MULTI_SELECT_FIELDS = ['Inviter', '面試主管', '單位', 'Job Function', '104_Position', '負責HR', 'Source'];
function buildInviterMultiSelectInput(sheetName, rec, field, col, idx, options, inputStyle) {
  var uid = 'invms_' + (_dlIdCounter++);
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');
  var selected = String(rawVal||'').split('、').map(function(s){return s.trim();}).filter(Boolean);
  var opts = options.slice();
  selected.forEach(function(s){ if (opts.indexOf(s) < 0) opts.push(s); }); // 舊資料裡有、但目前不在清單中的名字，也要能顯示、能維持勾選
  var summary = selected.length ? selected.join('、') : '未選擇';
  var optionsHtml = opts.map(function(o){
    var checked = selected.indexOf(o) >= 0;
    var oSafe = String(o).replace(/"/g,'&quot;');
    var oDisp = String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<label class="ms-dropdown-option"><input type="checkbox" '+(checked?'checked':'')+' data-val="'+oSafe+'" onchange="toggleInviterMsOption(\''+uid+'\',this)"> '+oDisp+'</label>';
  }).join('');
  return '<div class="ms-dropdown" id="'+uid+'" style="width:100%;">'+
    '<button type="button" class="ms-dropdown-toggle" style="width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box;" onclick="toggleMsDropdownPanel(\''+uid+'\')">'+
      '<span class="invms-summary">'+summary.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span> <span class="ms-dropdown-caret">▾</span></button>'+
    '<div class="ms-dropdown-panel" id="'+uid+'-panel" style="display:none;">'+
      optionsHtml+
      '<div class="invms-add-row">'+
        '<input type="text" id="'+uid+'-newname" placeholder="新增其他選項..." onkeydown="if(event.key===\'Enter\'){event.preventDefault();addInviterMsName(\''+uid+'\')}">'+
        '<button type="button" onclick="addInviterMsName(\''+uid+'\')">新增</button>'+
      '</div>'+
      '<div class="invms-clear-row"><span class="date-filter-clear" onclick="clearInviterMsSelection(\''+uid+'\')">清除已勾選</span></div>'+
    '</div>'+
    '<input type="hidden" class="invms-value" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" value="'+rawSafe+'">'+
  '</div>';
}

function clearInviterMsSelection(uid) {
  var container = document.getElementById(uid);
  if (!container) return;
  container.querySelectorAll('input[type=checkbox]').forEach(function(cb){ cb.checked = false; });
  var hidden = container.querySelector('.invms-value');
  hidden.value = '';
  var summaryEl = container.querySelector('.invms-summary');
  if (summaryEl) summaryEl.textContent = '未選擇';
  commitMaintainInputList(hidden);
}

function toggleInviterMsOption(uid, checkboxEl) {
  var container = document.getElementById(uid);
  var hidden = container.querySelector('.invms-value');
  var current = hidden.value.split('、').map(function(s){return s.trim();}).filter(Boolean);
  var val = checkboxEl.getAttribute('data-val');
  var i = current.indexOf(val);
  if (checkboxEl.checked) { if (i < 0) current.push(val); } else if (i >= 0) { current.splice(i,1); }
  var newVal = current.join('、');
  hidden.value = newVal;
  container.querySelector('.invms-summary').textContent = newVal || '未選擇';
  commitMaintainInputList(hidden);
}

function addInviterMsName(uid) {
  var container = document.getElementById(uid);
  var input = document.getElementById(uid+'-newname');
  var name = input.value.trim();
  if (!name) return;
  var hidden = container.querySelector('.invms-value');
  var current = hidden.value.split('、').map(function(s){return s.trim();}).filter(Boolean);
  if (current.indexOf(name) < 0) current.push(name);
  var newVal = current.join('、');
  hidden.value = newVal;
  input.value = '';
  container.querySelector('.invms-summary').textContent = newVal || '未選擇';
  var panel = document.getElementById(uid+'-panel');
  var label = document.createElement('label');
  label.className = 'ms-dropdown-option';
  var nameSafe = name.replace(/"/g,'&quot;');
  var nameDisp = name.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  label.innerHTML = '<input type="checkbox" checked data-val="'+nameSafe+'" onchange="toggleInviterMsOption(\''+uid+'\',this)"> '+nameDisp;
  panel.insertBefore(label, panel.querySelector('.invms-add-row'));
  commitMaintainInputList(hidden);
}

// 點進下拉輸入框時，先把目前的值存起來、清空欄位，讓瀏覽器顯示完整選單；如果最後沒有選新的，onblur 會還原
function dlInputFocus(el) {
  el.dataset.beforeFocus = el.value;
  el.value = '';
}

function dlInputRestoreIfEmpty(el) {
  if (!el.value.trim() && el.dataset.beforeFocus) {
    el.value = el.dataset.beforeFocus;
  }
}

async function commitMaintainInputList(el) {
  dlInputRestoreIfEmpty(el);
  var newVal = el.value.trim();
  var original = el.getAttribute('data-raw') || '';
  var field0 = el.getAttribute('data-field');
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field0) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field0) >= 0;
  if (newVal && (isDateField || isDateOnlyField)) newVal = normalizeDateForSave(field0, newVal);

  if (newVal === original) { el.value = newVal; return; }

  var sheet = el.getAttribute('data-sheet');
  var row = el.getAttribute('data-row');
  var col = el.getAttribute('data-col');
  var field = el.getAttribute('data-field');
  var idx = parseInt(el.getAttribute('data-idx'));

  var ok = await saveMaintainField(sheet, row, col, field, idx, newVal);
  if (ok) {
    el.setAttribute('data-raw', newVal.replace(/"/g,'&quot;'));
    el.value = newVal;
    // Inviter 更新後，依 Manager Information 自動同步 單位 欄位（僅 Candidate Records）
    if (sheet === 'Candidate Records' && field === 'Inviter') {
      await autoSyncBUFromInviter(newVal, row);
    }
    // 104_Position 更新後，自動擷取【】內文字同步到 Job Function 欄位（僅 Candidate Records）
    if (sheet === 'Candidate Records' && field === '104_Position') {
      await autoSyncJobFunctionFromPosition(newVal, row);
    }
  }
}

// 通用：把新值套用到欄位對應的輸入元件上的「畫面顯示」，同時支援一般 input/textarea/select，
// 以及勾選式多選下拉元件（單位／Job Function／104_Position／負責HR／Inviter／面試主管 現在都改成多選勾選）。
// 多選欄位被自動同步時視為整組換成這一個值（不與原本已勾選的項目合併），跟原本自動帶入單一值的行為一致。
function applyFieldDisplayValue(el, newVal) {
  if (!el) return;
  // 判斷這個欄位是不是勾選式多選元件：不管是查詢卡（class="invms-value"）還是新增人選表單
  // （class="new-cand-input"），特徵都是「隱藏的 input，包在 .ms-dropdown 容器裡」
  var msContainer = (el.tagName === 'INPUT' && el.type === 'hidden' && el.closest) ? el.closest('.ms-dropdown') : null;
  el.value = newVal;
  if (msContainer) {
    var selected = String(newVal||'').split('、').map(function(s){return s.trim();}).filter(Boolean);
    msContainer.querySelectorAll('.ms-dropdown-option input[type="checkbox"]').forEach(function(cb){
      cb.checked = selected.indexOf(cb.getAttribute('data-val')) >= 0;
    });
    var summaryEl = msContainer.querySelector('.invms-summary');
    if (summaryEl) summaryEl.textContent = selected.length ? selected.join('、') : '未選擇';
  }
}

// 依 Inviter 姓名查出對應單位，若跟目前 單位 不同就一併更新畫面與試算表
// Inviter 可能是多人（用「、」分隔），單位自動帶入時以第一位為準
async function autoSyncBUFromInviter(inviterName, row) {
  var firstName = String(inviterName||'').split('、')[0].trim();
  var bu = findBUByInviterName(firstName);
  if (!bu) return;
  var buEl = document.querySelector('[data-field="單位"][data-row="'+row+'"]');
  if (!buEl || buEl.value === bu) return;
  var buCol = buEl.getAttribute('data-col');
  var buIdx = parseInt(buEl.getAttribute('data-idx'));
  var ok = await saveMaintainField('Candidate Records', row, buCol, '單位', buIdx, bu);
  if (ok) {
    buEl.setAttribute('data-raw', bu.replace(/"/g,'&quot;'));
    applyFieldDisplayValue(buEl, bu);
    // 跨單位搜尋結果的資料不在 allData 裡，找不到時改查 allDataFull（完整名單）
    var d = allData.find(function(x){ return String(x._row) === String(row); }) ||
      allDataFull.find(function(x){ return String(x._row) === String(row); });
    if (d) d['單位'] = bu;
  }
}

// 依 104_Position 裡的【】文字，若跟目前 Job Function 不同就一併更新畫面與試算表
async function autoSyncJobFunctionFromPosition(positionVal, row) {
  var jf = extractJobFunctionFromPosition(positionVal);
  if (!jf) return;
  var jfEl = document.querySelector('[data-field="Job Function"][data-row="'+row+'"]');
  if (!jfEl || jfEl.value === jf) return;
  var jfCol = jfEl.getAttribute('data-col');
  var jfIdx = parseInt(jfEl.getAttribute('data-idx'));
  var ok = await saveMaintainField('Candidate Records', row, jfCol, 'Job Function', jfIdx, jf);
  if (ok) {
    jfEl.setAttribute('data-raw', jf.replace(/"/g,'&quot;'));
    applyFieldDisplayValue(jfEl, jf);
    // 跨單位搜尋結果的資料不在 allData 裡，找不到時改查 allDataFull（完整名單）
    var d = allData.find(function(x){ return String(x._row) === String(row); }) ||
      allDataFull.find(function(x){ return String(x._row) === String(row); });
    if (d) d['Job Function'] = jf;
  }
}

function renderTableCellInput(sheetName, rec, field, idx, customWidth) {
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var col = (maintainHeaders[sheetName] || Object.keys(rec)).indexOf(field) + 1;
  var dropdowns = MAINTAIN_DROPDOWNS[sheetName] || {};
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0;
  var displayVal = isDateOnlyField ? fmtDateOnly(rawVal) : isDateField ? fmtDate(rawVal) : rawVal;
  var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');
  var widthStyle = customWidth ? ('width:'+customWidth+';min-width:'+customWidth+';') : 'min-width:60px;';

  if (dropdowns[field]) {
    var options = dropdowns[field]();
    return buildDropdownDatalistInput(sheetName, rec, field, col, idx, options,
      'font-size:12px;padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);'+(customWidth?('width:'+customWidth+';'):'max-width:170px;width:100%;')+'box-sizing:border-box;');
  }

  if (isDateOnlyField && sheetName === 'Headcount Records') {
    // Headcount Records 的日期欄位（目前是 Requisition Date）改用原生日期選擇器，點一下就能從月曆挑日期，
    // 不用再手動打字；value 需要 yyyy-mm-dd 格式，儲存回試算表時再轉回 yyyy/mm/dd（跟其他日期欄位一致）。
    return '<input type="date" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
      'value="'+dateOnlyToISO(rawVal)+'" onchange="commitMaintainDateCell(this)" '+
      'style="font-size:12px;padding:5px 7px;border:1px solid var(--border);border-radius:6px;cursor:pointer;'+widthStyle+'">';
  }

  if (isDateField || isDateOnlyField) {
    // 日期類欄位維持單行 contenteditable，才能套用日期格式清理邏輯
    return '<div contenteditable="true" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
      'onfocus="enterMaintainEdit(this)" onblur="commitMaintainCell(this)" '+
      'style="font-size:12px;padding:5px 7px;border-radius:6px;min-height:16px;cursor:text;'+widthStyle+'">'+
      (displayVal||'').toString().replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>';
  }

  // 一般文字欄位改用 textarea：支援分行、像 Excel 儲存格一樣可以換行顯示與編輯
  // Headcount Records 只有 Duties、Memo 這兩個欄位開放使用者自己拖拉調整欄寬（其他欄位寬度是固定的，見 renderHeadcount 的 colgroup 設定）
  var textareaResize = 'resize:vertical;';
  if (sheetName === 'Headcount Records') textareaResize = (field === 'Duties' || field === 'Memo') ? 'resize:both;' : 'resize:none;';
  var escapedForTextarea = String(rawVal||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<textarea data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
    'onfocus="enterMaintainEditTA(this)" onblur="commitMaintainCellTA(this)" '+
    'style="font-size:12px;padding:5px 7px;border:1px solid transparent;border-radius:6px;min-height:32px;cursor:text;font-family:inherit;'+textareaResize+'white-space:pre-wrap;word-break:break-word;'+widthStyle+'" '+
    'onfocusin="this.style.borderColor=\'var(--border)\'" onfocusout="this.style.borderColor=\'transparent\'">'+escapedForTextarea+'</textarea>';
}

function enterMaintainEditTA(el) {
  el.dataset.original = el.value;
}

async function commitMaintainCellTA(el) {
  var newVal = el.value;
  var original = el.dataset.original !== undefined ? el.dataset.original : (el.getAttribute('data-raw')||'');
  if (newVal === original) return;

  var field0 = el.getAttribute('data-field');
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field0) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field0) >= 0;
  if (newVal && (isDateField || isDateOnlyField)) newVal = normalizeDateForSave(field0, newVal);

  var sheet = el.getAttribute('data-sheet');
  var row = el.getAttribute('data-row');
  var col = el.getAttribute('data-col');
  var field = el.getAttribute('data-field');
  var idx = parseInt(el.getAttribute('data-idx'));

  var ok = await saveMaintainField(sheet, row, col, field, idx, newVal);
  if (ok) {
    el.setAttribute('data-raw', newVal.replace(/"/g,'&quot;'));
    el.dataset.original = newVal;
    el.value = isDateOnlyField ? fmtDateOnly(newVal) : isDateField ? fmtDate(newVal) : newVal;
  }
}

// ===== HEADCOUNT OVERVIEW =====
// 資料來源：自動從 Apps Script 回傳的 headcount 陣列載入（doGet 已包含 Headcount Records 分頁）
var hcRawData = [];
var hcViewMode = 'current'; // 'current' = 目前缺額, 'past' = 過往 Headcount（已補實）

function switchHcView(mode) {
  hcViewMode = mode;
  document.getElementById('hcViewCurrentBtn').classList.toggle('active', mode==='current');
  document.getElementById('hcViewPastBtn').classList.toggle('active', mode==='past');
  document.getElementById('hcSectionTitle').textContent = mode==='past' ? '過往 Headcount（已補實）' : '各單位缺額明細';
  renderHeadcount();
}
function loadHeadcountData(records) {
  hcRawData = records || [];
  document.getElementById('hcEmptyState').style.display = hcRawData.length ? 'none' : '';
  document.getElementById('hcContent').style.display = hcRawData.length ? '' : 'none';
  document.getElementById('hcSub').textContent = hcRawData.length
    ? '共 '+hcRawData.length+' 筆職缺異動記錄'
    : '尚無 Headcount 資料';
  renderHeadcount();
}

function renderHeadcount() {
  if (!hcRawData.length) {
    var emptyJobTotalsEl = document.getElementById('hcJobTotalCards');
    if (emptyJobTotalsEl) emptyJobTotalsEl.innerHTML = '<div class="empty">無資料</div>';
    return;
  }
  var divKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Division';}) || 'Division';
  var jobKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Job Function';}) || 'Job Function';
  // 「過往 Headcount」的判斷要用「遞補人員職等」（遞補人員本身的職等），不是原職缺的「職等」欄位
  var gradeKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='遞補人員職等';}) || (Object.keys(hcRawData[0]).find(function(k){return k.includes('遞補') && k.includes('職等');})) || '遞補人員職等';
  var succKey = Object.keys(hcRawData[0]).find(function(k){return k.includes('Successor')||k.trim()==='遞補人員';}) || 'Successor';

  // 表格顯示欄位：跟「Headcount Records」工作表保持一致，不再寫死清單，工作表增減/改名欄位這裡會自動跟著變。
  // Division／Job Function 已經是卡片分組依據（上面的單位標題／職稱區塊），這裡不重複顯示；PS 開頭的內部欄位也不顯示。
  var allHeaders = maintainHeaders['Headcount Records'] || Object.keys(hcRawData[0]).filter(function(k){return k!=='_row';});
  var displayHeaders = allHeaders.filter(function(h){
    return h && h !== divKey && h !== jobKey && !h.includes('PS');
  });

  var hcBuOptions = [...new Set(hcRawData.map(function(r){return String(r[divKey]||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('hcBuBar', 'hc-bu', hcBuOptions);
  var hcJobOptions = buildMultiValueOptions(hcRawData, function(r){return r[jobKey];});
  renderMultiFilterBar('hcJobBar', 'hc-job', hcJobOptions);

  var filtered = hcRawData.filter(function(r){
    return multiFilterPass('hc-bu', r[divKey]) && multiFilterPassMulti('hc-job', r[jobKey]);
  });

  var groups = {};
  filtered.forEach(function(r){
    var div = String(r[divKey]||'').trim();
    var job = String(r[jobKey]||'').trim();
    if (!groups[div]) groups[div] = {div:div, total:0, vacantTotal:0, pastTotal:0, jobs:{}};
    if (!groups[div].jobs[job]) groups[div].jobs[job] = {job:job, total:0, rows:[]};
    groups[div].total++;
    groups[div].jobs[job].total++;
    var succ = String(r[succKey]||'').trim();
    var grade = String(r[gradeKey]||'').trim();
    var isVacant = !succ;
    var isPastFilled = !!succ && !!grade; // 過往 Headcount：遞補人員、職等都非空白
    if (isVacant) groups[div].vacantTotal++;
    if (isPastFilled) groups[div].pastTotal++;
    groups[div].jobs[job].rows.push({
      raw: r,
      vacant: isVacant,
      pastFilled: isPastFilled
    });
  });

  var isPastMode = hcViewMode === 'past';
  var divArr = Object.values(groups).sort(function(a,b){
    return isPastMode ? (b.pastTotal - a.pastTotal) : (b.vacantTotal - a.vacantTotal);
  });

  document.getElementById('hcCards').innerHTML = divArr.map(function(g){
    var divColor = '#4F46E5';
    var jobArr = Object.values(g.jobs).sort(function(a,b){
      var af = a.rows.filter(function(r){return isPastMode ? r.pastFilled : r.vacant;}).length;
      var bf = b.rows.filter(function(r){return isPastMode ? r.pastFilled : r.vacant;}).length;
      return bf - af;
    });

    var jobsHtml = jobArr.map(function(j){
      var displayRows = j.rows.filter(function(r){return isPastMode ? r.pastFilled : r.vacant;});
      var countInJob = displayRows.length;
      var jc = '#4F46E5';

      if (countInJob === 0) return ''; // 沒有符合目前模式的資料就不顯示

      // 欄寬設定：Department／Section／Location／開缺理由縮窄，職等／遞補人員職等再縮窄一次，
      // Duties／Memo 則依目前顯示資料的實際內容長度自動加長（像 Excel 欄位一樣），其他欄位可以寬一點。
      var colWidths = displayHeaders.map(function(h){
        if (h === 'Duties' || h === 'Memo') {
          var maxLen = 6;
          displayRows.forEach(function(rr){
            String(rr.raw[h]||'').split('\n').forEach(function(line){ if (line.length > maxLen) maxLen = line.length; });
          });
          return Math.max(160, Math.min(480, maxLen*8+28));
        }
        if (h==='Department' || h==='Section' || h==='Location' || h==='開缺理由' || h.includes('Reason')) return 85;
        if (h.includes('職等')) return 55;
        return 190;
      });
      colWidths.push(40); // 最後一欄放刪除按鈕

      var rowsHtml = displayRows.map(function(rr){
        var r = rr.raw;
        var idx = hcRawData.indexOf(r);
        var cells = displayHeaders.map(function(h){
          return '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, h, idx, '100%')+'</td>';
        }).join('');
        var deleteCell = '<td style="padding:2px;text-align:center;"><button title="刪除這筆 Headcount 資料" onclick="deleteHeadcountRow('+r._row+')" style="border:none;background:none;cursor:pointer;font-size:14px;color:#EF4444;">🗑️</button></td>';
        return '<tr>'+cells+deleteCell+'</tr>';
      }).join('');

      return '<div style="margin-bottom:10px;">'+
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">'+
          '<span style="font-size:12px;font-weight:600;">'+j.job+'</span>'+
          '<span style="font-size:11px;font-weight:700;color:'+jc+';background:'+jc+'18;padding:1px 8px;border-radius:10px;">'+countInJob+(isPastMode?' 已補實':' 缺額')+'</span>'+
        '</div>'+
        '<div style="border:1px solid var(--border);border-radius:8px;overflow-x:auto;">'+
          '<table style="table-layout:fixed;border-collapse:collapse;">'+
            '<colgroup>'+colWidths.map(function(w){ return '<col style="width:'+w+'px;">'; }).join('')+'</colgroup>'+
            '<thead><tr style="background:var(--bg);">'+
              displayHeaders.map(function(h){ return '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+h+'</th>'; }).join('')+
              '<th></th>'+
            '</tr></thead>'+
            '<tbody>'+rowsHtml+'</tbody>'+
          '</table>'+
        '</div>'+
      '</div>';
    }).join('');

    var totalForDiv = isPastMode ? g.pastTotal : g.vacantTotal;
    var divSafe = String(g.div||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return '<div class="mini-card" style="padding:18px 20px;border:1.5px solid '+divColor+'40;">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:2px solid '+divColor+'30;">'+
        '<div style="font-size:19px;font-weight:800;color:var(--text-primary);">'+g.div+'</div>'+
        '<div style="display:flex;align-items:center;gap:8px;">'+
          '<button class="refresh-btn" style="margin-left:0;" onclick="openHcNewRowModal(\''+divSafe+'\')">＋ 新增 Headcount</button>'+
          '<div style="display:flex;align-items:baseline;gap:6px;background:'+divColor+'15;padding:4px 12px;border-radius:10px;">'+
            '<span style="font-size:30px;font-weight:800;color:'+divColor+';line-height:1;">'+totalForDiv+'</span>'+
            '<span style="font-size:12px;font-weight:600;color:'+divColor+';">'+(isPastMode?'位已補實':'個缺額')+'</span>'+
          '</div>'+
        '</div>'+
      '</div>'+
      (jobsHtml || '<div style="font-size:12px;color:var(--text-tertiary);text-align:center;padding:12px 0;">'+(isPastMode?'目前無過往紀錄':'目前無缺額')+'</div>')+
    '</div>';
  }).join('');

  // 各 Job Function 缺額總人數（跨 Division 統計）
  var jobTotals = {};
  filtered.forEach(function(r){
    var job = String(r[jobKey]||'').trim();
    if (!job) return;
    if (!jobTotals[job]) jobTotals[job] = 0;
    var succ = String(r[succKey]||'').trim();
    if (!succ) jobTotals[job]++;
  });
  var jobTotalArr = Object.keys(jobTotals).map(function(j){return {job:j, count:jobTotals[j]};}).sort(function(a,b){return b.count-a.count;});
  document.getElementById('hcJobTotalCards').innerHTML = jobTotalArr.length===0 ? '<div class="empty">無資料</div>' :
    jobTotalArr.map(function(jt){
      return '<div class="mini-card" style="padding:14px 16px;text-align:center;">'+
        '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">'+jt.job+'</div>'+
        '<div style="font-size:24px;font-weight:700;color:#4F46E5;">'+jt.count+'</div>'+
      '</div>';
    }).join('');
}

// ===== HEADCOUNT MEMO =====
var selectedMemoRow = null;

function openMemoModal(el) {
  selectedMemoRow = parseInt(el.getAttribute('data-row'));
  var currentMemo = el.getAttribute('data-memo') || '';
  document.getElementById('memoTextarea').value = currentMemo;
  document.getElementById('memoModal').style.display = 'flex';
  setTimeout(function(){document.getElementById('memoTextarea').focus();}, 50);
}

function closeMemoModal() {
  document.getElementById('memoModal').style.display = 'none';
  selectedMemoRow = null;
}

async function saveMemo() {
  if (!selectedMemoRow) return;
  var memo = document.getElementById('memoTextarea').value;
  var row = selectedMemoRow;
  closeMemoModal();
  showToast('儲存中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=updateMemo&row=' + encodeURIComponent(row) + '&memo=' + encodeURIComponent(memo);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    showToast('✓ 備註已儲存');
    // 本地更新
    var rec = hcRawData.find(function(r){return r._row===row;});
    if (rec) {
      var memoKey2 = Object.keys(rec).find(function(k){return k.trim()==='Memo';}) || 'Memo';
      rec[memoKey2] = memo;
    }
    renderHeadcount();
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
  }
}

// ===== TRENDS =====
var TREND_COLORS = ['#F59E0B','#10B981','#3B82F6','#8B5CF6','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16','#06B6D4','#EF4444','#A855F7','#22C55E','#0EA5E9'];
var trendChartType = { monthly:'bar' };
var WEEKDAY_CN = ['日','一','二','三','四','五','六'];
function fmtTrendWeekLabel(d) {
  return (d.getMonth()+1)+'/'+d.getDate()+'('+WEEKDAY_CN[d.getDay()]+')';
}
var trendCache = {};

function getDayKey(d) {
  return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0');
}
function getWeekEnd(d) {
  var dt = new Date(d);
  var day = dt.getDay();
  dt.setDate(dt.getDate() + (6 - day));
  dt.setHours(0,0,0,0);
  return dt;
}

function setTrendChartType(card, type, el) {
  trendChartType[card] = type;
  document.querySelectorAll('.trend-toggle-group[data-card="'+card+'"] .pos-btn').forEach(function(b){b.classList.remove('active');});
  el.classList.add('active');
  renderTrendCard(card);
}

function toggleTrendDetail(card) {
  var el = document.getElementById('trend'+card.charAt(0).toUpperCase()+card.slice(1)+'Detail');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function drawChart(containerId, type, labels, series, maxVal) {
  if (type === 'bar') drawBarChartInner(containerId, labels, series, maxVal);
  else drawLineChartInner(containerId, labels, series, maxVal);
}

function drawLineChartInner(containerId, labels, series, maxVal) {
  var chartW = Math.max(460, labels.length*60), chartH = 200, padL=36, padR=16, padT=16, padB=30;
  var plotW = chartW-padL-padR, plotH = chartH-padT-padB;
  var xStep = plotW/(labels.length-1||1);
  function xPos(i){return padL+i*xStep;}
  function yPos(v){return padT+plotH-(v/maxVal)*plotH;}

  var svg = '<svg width="100%" height="'+chartH+'" viewBox="0 0 '+chartW+' '+chartH+'" preserveAspectRatio="xMinYMid meet">';
  for(var g=0;g<=4;g++){
    var gy = padT + plotH - (g/4)*plotH;
    svg += '<line x1="'+padL+'" y1="'+gy+'" x2="'+(chartW-padR)+'" y2="'+gy+'" stroke="#E8EAED" stroke-width="1"/>';
    svg += '<text x="'+(padL-6)+'" y="'+(gy+3)+'" font-size="9" fill="#9CA3AF" text-anchor="end">'+Math.round(g/4*maxVal)+'</text>';
  }
  labels.forEach(function(lbl,i){
    svg += '<text x="'+xPos(i)+'" y="'+(chartH-padB+16)+'" font-size="9" fill="#6B7280" text-anchor="middle">'+lbl+'</text>';
  });
  series.forEach(function(s, si){
    var color = TREND_COLORS[si%TREND_COLORS.length];
    var pts = s.data.map(function(v,i){return xPos(i)+','+yPos(v);}).join(' ');
    svg += '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2"/>';
    s.data.forEach(function(v,i){
      svg += '<circle cx="'+xPos(i)+'" cy="'+yPos(v)+'" r="3" fill="'+color+'"><title>'+s.name+': '+v+'</title></circle>';
      if (v > 0) svg += '<text x="'+xPos(i)+'" y="'+(yPos(v)-6)+'" font-size="9" fill="'+color+'" text-anchor="middle" font-weight="600">'+v+'</text>';
    });
  });
  svg += '</svg>';
  var legend = series.length>1 ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;">'+series.map(function(s,i){
    return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-secondary);"><div style="width:8px;height:8px;border-radius:2px;background:'+TREND_COLORS[i%TREND_COLORS.length]+'"></div>'+s.name+'</div>';
  }).join('')+'</div>' : '';
  document.getElementById(containerId).innerHTML = svg + legend;
}

function drawBarChartInner(containerId, labels, series, maxVal) {
  var chartW = Math.max(460, labels.length*70), chartH = 200, padL=36, padR=16, padT=16, padB=30;
  var plotW = chartW-padL-padR, plotH = chartH-padT-padB;
  var groupW = plotW/labels.length;
  var barW = Math.max(5, groupW/(series.length+1));

  var svg = '<svg width="100%" height="'+chartH+'" viewBox="0 0 '+chartW+' '+chartH+'" preserveAspectRatio="xMinYMid meet">';
  for(var g=0;g<=4;g++){
    var gy = padT + plotH - (g/4)*plotH;
    svg += '<line x1="'+padL+'" y1="'+gy+'" x2="'+(chartW-padR)+'" y2="'+gy+'" stroke="#E8EAED" stroke-width="1"/>';
    svg += '<text x="'+(padL-6)+'" y="'+(gy+3)+'" font-size="9" fill="#9CA3AF" text-anchor="end">'+Math.round(g/4*maxVal)+'</text>';
  }
  labels.forEach(function(lbl, li){
    var groupX = padL + li*groupW;
    series.forEach(function(s, si){
      var v = s.data[li]||0;
      var bh = (v/maxVal)*plotH;
      var bx = groupX + si*barW + barW*0.3;
      var by = padT+plotH-bh;
      svg += '<rect x="'+bx+'" y="'+by+'" width="'+(barW*0.8)+'" height="'+bh+'" fill="'+TREND_COLORS[si%TREND_COLORS.length]+'" rx="2"><title>'+s.name+': '+v+'</title></rect>';
      if (v > 0) svg += '<text x="'+(bx+barW*0.4)+'" y="'+(by-4)+'" font-size="9" fill="'+TREND_COLORS[si%TREND_COLORS.length]+'" text-anchor="middle" font-weight="600">'+v+'</text>';
    });
    svg += '<text x="'+(groupX+groupW/2)+'" y="'+(chartH-padB+16)+'" font-size="9" fill="#6B7280" text-anchor="middle">'+lbl+'</text>';
  });
  svg += '</svg>';
  var legend = series.length>1 ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;">'+series.map(function(s,i){
    return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-secondary);"><div style="width:8px;height:8px;border-radius:2px;background:'+TREND_COLORS[i%TREND_COLORS.length]+'"></div>'+s.name+'</div>';
  }).join('')+'</div>' : '';
  document.getElementById(containerId).innerHTML = svg + legend;
}

function drawTrendTable(headId, bodyId, labels, series, stashKey) {
  document.getElementById(headId).innerHTML = '<th>項目</th>' + labels.map(function(l){return '<th style="text-align:center">'+l+'</th>';}).join('');
  if (stashKey) trendTableStash[stashKey] = series;
  var rows = series.map(function(s, si){
    var cells = s.data.map(function(v, wi){
      var hasRecords = !!(s.records && s.records[wi] && s.records[wi].length);
      var style = 'text-align:center;' + (v>0?'font-weight:600;color:'+TREND_COLORS[si%TREND_COLORS.length]+';':'color:var(--text-tertiary);') + (hasRecords ? 'cursor:pointer;text-decoration:underline dotted;' : '');
      var onclickAttr = hasRecords ? ' onclick="drillTrendTableCell(\''+stashKey+'\','+si+','+wi+')"' : '';
      return '<td style="'+style+'"'+onclickAttr+'>'+v+'</td>';
    }).join('');
    return '<tr><td style="font-weight:600;white-space:nowrap"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+TREND_COLORS[si%TREND_COLORS.length]+';margin-right:6px;"></span>'+s.name+'</td>'+cells+'</tr>';
  }).join('');
  var totalCells = labels.map(function(l,li){
    var sum = series.reduce(function(a,s){return a+(s.data[li]||0);},0);
    return '<td style="text-align:center;font-weight:700">'+sum+'</td>';
  }).join('');
  rows += '<tr style="background:var(--bg)"><td style="font-weight:700">總計</td>'+totalCells+'</tr>';
  document.getElementById(bodyId).innerHTML = rows;
}

// stashKey -> 該次渲染用的 series（含每格明細 records），供表格點擊鑽取用
var trendTableStash = {};
function drillTrendTableCell(stashKey, si, wi) {
  var series = trendTableStash[stashKey];
  if (!series) return;
  var s = series[si];
  if (!s || !s.records) return;
  showTrendDrilldown(s.name, s.records[wi] || []);
}

function renderTrendCard(card) {
  var c = trendCache[card];
  if (!c) return;
  var chartId = 'trend'+card.charAt(0).toUpperCase()+card.slice(1)+'Chart';
  drawChart(chartId, trendChartType[card], c.labels, c.series, c.maxVal);
}

// ---- 週次區間內、依日期欄位（可能有多種欄位名稱）比對的明細清單 ----
function countByDateFields(data, weeks, fields) {
  return weeks.map(function(we){
    var ws = new Date(we); ws.setDate(ws.getDate()-6);
    return data.filter(function(rec){
      var raw = '';
      for (var i=0;i<fields.length;i++){ if (rec[fields[i]]) { raw = rec[fields[i]]; break; } }
      var dt = parseDateTime(raw);
      if (!dt) return false;
      dt.setHours(0,0,0,0);
      return dt >= ws && dt <= we;
    });
  });
}
// ---- 週次區間內、依 Result 是否符合＋Result Update_date 比對的明細清單 ----
function countByStage(data, weeks, matchFn) {
  return weeks.map(function(we){
    var ws = new Date(we); ws.setDate(ws.getDate()-6);
    return data.filter(function(rec){
      if (!matchFn(rec.Result)) return false;
      var ud = parseDateTime(rec['Result Update_date'] || rec.Update_date || rec['Update date'] || '');
      if (!ud) return false;
      ud.setHours(0,0,0,0);
      return ud >= ws && ud <= we;
    });
  });
}
function makeTrendSeries(name, recordsPerWeek) {
  return { name: name, data: recordsPerWeek.map(function(r){return r.length;}), records: recordsPerWeek };
}

// 每月 Headcount（當月月底仍未結案的缺額數）＆ Onboard（依 Candidate Records「Onboard date」）
// 只依目前 tr-bu／tr-job 篩選，不跟著上方時間篩選走（跟「各單位 Headcount 缺額」圖表口徑一致）；固定顯示最近 6 個月。
// Headcount Records 沒有「實際結案日期」欄位，用「遞補人員」姓名比對 Candidate Records 找到對應人選的 Onboard date 當作結案日：
// 到職日在該月月底之前 → 那個月底已結案；有遞補人員姓名但找不到對應到職日（姓名沒對上／人選還沒填到職日）→ 保守視為已結案，避免高估未結案數；
// 完全沒有遞補人員姓名 → 一直算未結案，直到有人遞補為止。
function computeMonthlyHeadcountOnboard() {
  var months = [];
  var base = new Date(); base.setDate(1); base.setHours(0,0,0,0);
  for (var i=5;i>=0;i--) months.push(new Date(base.getFullYear(), base.getMonth()-i, 1));
  var labels = months.map(function(m){ return m.getFullYear()+'/'+String(m.getMonth()+1).padStart(2,'0'); });
  var monthEnds = months.map(function(m){ return new Date(m.getFullYear(), m.getMonth()+1, 0, 23, 59, 59); });

  function monthIndexOf(dateVal) {
    var dt = parseDateTime(dateVal);
    if (!dt) return -1;
    for (var i=0;i<months.length;i++) {
      if (dt.getFullYear()===months[i].getFullYear() && dt.getMonth()===months[i].getMonth()) return i;
    }
    return -1;
  }

  var reqKey = (hcRawData && hcRawData.length)
    ? (Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Requisition Date';}) || 'Requisition Date')
    : 'Requisition Date';
  var divKey = (hcRawData && hcRawData.length) ? (Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Division';}) || 'Division') : 'Division';
  var jobKeyHc = (hcRawData && hcRawData.length) ? (Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Job Function';}) || 'Job Function') : 'Job Function';
  var succKeyHc = (hcRawData && hcRawData.length) ? (Object.keys(hcRawData[0]).find(function(k){return k.includes('Successor')||k.trim()==='遞補人員';}) || 'Successor') : 'Successor';

  var candidatePool = (typeof allDataFull !== 'undefined' && allDataFull && allDataFull.length) ? allDataFull : allData;
  function onboardDateOfSuccessor(name) {
    var n = String(name||'').trim();
    if (!n) return null;
    var cand = candidatePool.find(function(d){ return String(d.Name||'').trim() === n; });
    return cand ? parseDateTime(cand['Onboard date']) : null;
  }

  var hcCounts = months.map(function(){ return 0; });
  (hcRawData||[]).forEach(function(r){
    if (!multiFilterPass('tr-bu', r[divKey])) return;
    if (!multiFilterPassMulti('tr-job', r[jobKeyHc])) return;
    var reqDate = parseDateTime(r[reqKey]);
    if (!reqDate) return; // 沒有開缺日期就不計入
    var succName = String(r[succKeyHc]||'').trim();
    var onboardDate = succName ? onboardDateOfSuccessor(succName) : null;
    months.forEach(function(m, idx){
      if (reqDate > monthEnds[idx]) return; // 那個月底之後才開缺，還沒算進去
      if (succName && onboardDate && onboardDate <= monthEnds[idx]) return; // 到職日在月底前 → 已結案
      if (succName && !onboardDate) return; // 有遞補人員但找不到到職日 → 保守視為已結案
      hcCounts[idx]++;
    });
  });

  var onboardRecords = months.map(function(){ return []; });
  allData.forEach(function(d){
    if (!multiFilterPass('tr-bu', d['單位'])) return;
    if (!multiFilterPassMulti('tr-job', d['Job Function'])) return;
    var idx = monthIndexOf(d['Onboard date']);
    if (idx < 0) return;
    onboardRecords[idx].push(d);
  });

  return {
    labels: labels,
    // Headcount 這條線不附 records：Headcount Records 的欄位跟候選人卡片格式不同，明細表格點下去不適合用候選人卡片呈現
    series: [
      { name:'Headcount（未結案缺額）', data: hcCounts },
      { name:'Onboard', data: onboardRecords.map(function(a){return a.length;}), records: onboardRecords }
    ]
  };
}

// Headcount＋Onboard 組合圖：Headcount 固定長條、Onboard 固定折線，同一張圖呈現
function drawComboBarLineChart(containerId, labels, barSeries, lineSeries, maxVal) {
  var chartW = Math.max(460, labels.length*70), chartH = 200, padL=36, padR=16, padT=16, padB=30;
  var plotW = chartW-padL-padR, plotH = chartH-padT-padB;
  var groupW = plotW/labels.length;
  var barW = Math.max(20, groupW*0.4);
  function xCenter(li){ return padL+li*groupW+groupW/2; }
  function yPos(v){ return padT+plotH-(v/maxVal)*plotH; }
  var barColor = TREND_COLORS[0], lineColor = TREND_COLORS[1];

  var svg = '<svg width="100%" height="'+chartH+'" viewBox="0 0 '+chartW+' '+chartH+'" preserveAspectRatio="xMinYMid meet">';
  for (var g=0; g<=4; g++) {
    var gy = padT + plotH - (g/4)*plotH;
    svg += '<line x1="'+padL+'" y1="'+gy+'" x2="'+(chartW-padR)+'" y2="'+gy+'" stroke="#E8EAED" stroke-width="1"/>';
    svg += '<text x="'+(padL-6)+'" y="'+(gy+3)+'" font-size="9" fill="#9CA3AF" text-anchor="end">'+Math.round(g/4*maxVal)+'</text>';
  }
  labels.forEach(function(lbl, li){
    var v = barSeries.data[li]||0;
    var bh = (v/maxVal)*plotH;
    var bx = xCenter(li) - barW/2;
    var by = padT+plotH-bh;
    svg += '<rect x="'+bx+'" y="'+by+'" width="'+barW+'" height="'+bh+'" fill="'+barColor+'" rx="2"><title>'+barSeries.name+': '+v+'</title></rect>';
    if (v > 0) svg += '<text x="'+xCenter(li)+'" y="'+(by-4)+'" font-size="9" fill="'+barColor+'" text-anchor="middle" font-weight="600">'+v+'</text>';
    svg += '<text x="'+xCenter(li)+'" y="'+(chartH-padB+16)+'" font-size="9" fill="#6B7280" text-anchor="middle">'+lbl+'</text>';
  });
  var pts = lineSeries.data.map(function(v,i){ return xCenter(i)+','+yPos(v); }).join(' ');
  svg += '<polyline points="'+pts+'" fill="none" stroke="'+lineColor+'" stroke-width="2"/>';
  lineSeries.data.forEach(function(v,i){
    svg += '<circle cx="'+xCenter(i)+'" cy="'+yPos(v)+'" r="3" fill="'+lineColor+'"><title>'+lineSeries.name+': '+v+'</title></circle>';
    if (v > 0) svg += '<text x="'+xCenter(i)+'" y="'+(yPos(v)-6)+'" font-size="9" fill="'+lineColor+'" text-anchor="middle" font-weight="600">'+v+'</text>';
  });
  svg += '</svg>';
  var legend = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;">'+
    '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-secondary);"><div style="width:8px;height:8px;border-radius:2px;background:'+barColor+'"></div>'+barSeries.name+'</div>'+
    '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-secondary);"><div style="width:8px;height:8px;border-radius:2px;background:'+lineColor+'"></div>'+lineSeries.name+'</div>'+
  '</div>';
  document.getElementById(containerId).innerHTML = svg + legend;
}

// 單位／Job Function 若narrowed到2個以上，兩張圖要分開顯示各自數據、不加總；
// 優先以單位分（若單位narrowed到多選），否則以 Job Function 分
function getTrendBreakdownField() {
  var buState = multiFilterState['tr-bu'];
  if (buState && isMultiFilterNarrowed('tr-bu') && buState.selected.size >= 2) return '單位';
  var jobState = multiFilterState['tr-job'];
  if (jobState && isMultiFilterNarrowed('tr-job') && jobState.selected.size >= 2) return 'Job Function';
  return null;
}
function getTrendGroups(data, field) {
  if (!field) return [{label:null, data:data}];
  var vals = [...new Set(data.map(function(d){return String(d[field]||'').trim();}))].filter(Boolean).sort();
  return vals.map(function(v){
    return {label:v, data: data.filter(function(d){return String(d[field]||'').trim()===v;})};
  });
}
function computeBreakdownSeries(groups, computeFn, weeks) {
  var out = [];
  groups.forEach(function(g){
    computeFn(g.data, weeks).forEach(function(s){
      out.push(makeTrendSeries(g.label ? (g.label+'－'+s.name) : s.name, s.records));
    });
  });
  return out;
}

// ---- 人選進度統計（樹狀圖，橫向）----
// 完全依「分類Result」工作表的「階段」「分類1」欄位動態分組計算，不再寫死在程式裡：
// 「階段」決定樹狀圖橫向由左到右有哪幾個節點（依工作表列出的先後順序）；
// 「分類2」目前沒有使用，之後如果要再細分可以再擴充。
var lastTrendData = [];

// 把 resultCategories（每個 Result 各一列）依「階段」分組，同一階段內再依「分類1」分組
function buildProgressTreeStages() {
  var stages = [];
  var stageIdx = {};
  resultCategories.forEach(function(rc){
    var stage = String(rc.stage||'').trim();
    if (!stage) return;
    if (!(stage in stageIdx)) {
      stageIdx[stage] = stages.length;
      stages.push({ stage: stage, results: [], subGroups: [], subIdx: {} });
    }
    var s = stages[stageIdx[stage]];
    s.results.push(rc.Result);
    var cat1 = String(rc.cat1||'').trim();
    if (cat1) {
      if (!(cat1 in s.subIdx)) {
        s.subIdx[cat1] = s.subGroups.length;
        s.subGroups.push({ label: cat1, results: [] });
      }
      s.subGroups[s.subIdx[cat1]].results.push(rc.Result);
    }
  });
  return stages;
}

// 每次 render 都重新建立，index 對應到目前畫面上每個節點的「標題＋篩選條件」，供點擊鑽取使用
var _progressTreeDrilldown = [];
function showProgressTreeDrilldown(idx) {
  var g = _progressTreeDrilldown[idx];
  if (!g) return;
  // 電訪／面試／錄取階段底下的分類卡片（進行中／已結案）帶有 resultValues：先列出這個分類裡各個 Result 的人數，
  // 點了某個 Result 卡片之後，下面才顯示只屬於那個 Result 的人選名單
  if (g.resultValues) {
    showResultBreakdownDrilldown(g.label, g.resultValues, lastTrendData);
  } else {
    showTrendDrilldown(g.label, lastTrendData.filter(g.test));
  }
}

var _resultBreakdownCounts = [];
function showResultBreakdownDrilldown(title, resultValues, data) {
  document.getElementById('trendDrilldownTitle').textContent = title;
  _resultBreakdownCounts = resultValues.map(function(rv){
    var records = data.filter(function(d){ return d.Result === rv; });
    return { result: rv, records: records };
  });
  var totalN = _resultBreakdownCounts.reduce(function(a,c){ return a+c.records.length; }, 0);
  var listEl = document.getElementById('trendDrilldownList');
  listEl.innerHTML =
    '<div style="font-size:11px;color:var(--text-secondary);">共 '+totalN+' 人，點選下方 Result 查看名單</div>'+
    _resultBreakdownCounts.map(function(c, i){
      return '<div class="mini-card" style="cursor:pointer;padding:10px 14px;" onclick="showResultBreakdownCandidates('+i+')">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;">'+
          '<span style="font-size:13px;font-weight:600;">'+c.result+'</span>'+
          '<span style="font-size:13px;font-weight:700;color:var(--accent);">'+c.records.length+' 人</span>'+
        '</div>'+
      '</div>';
    }).join('')+
    '<div id="resultBreakdownCandList" style="margin-top:6px;display:flex;flex-direction:column;gap:8px;"></div>';
  document.getElementById('trendDrilldownModal').style.display = 'flex';
}
function showResultBreakdownCandidates(i) {
  var c = _resultBreakdownCounts[i];
  var listEl = document.getElementById('resultBreakdownCandList');
  if (!c || !listEl) return;
  listEl.innerHTML = c.records.length === 0 ? '<div class="empty" style="padding:16px 0;">目前無資料</div>' :
    c.records.map(function(d){
      return '<div class="mini-card"><div class="mini-card-top"><div class="mini-card-name">'+(d.Name||'')+'</div><div class="mini-card-bu">'+(d['單位']||'')+'</div></div>'+
        '<div class="mini-card-pos">'+(d['Job Function']||'')+(d.Source?' · '+d.Source:'')+'</div>'+
        '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">目前狀態：'+(d.Result||'—')+'</div></div>';
    }).join('');
}

function renderProgressTree(trendData) {
  var wrap = document.getElementById('progressTreeFlow');
  if (!wrap) return;
  _progressTreeDrilldown = [];

  var invitedTest = function(d){ return !!(d.invite_date || d['invite date']); };
  var rootIdx = _progressTreeDrilldown.length;
  _progressTreeDrilldown.push({ label:'邀約', test: invitedTest });
  var invitedCount = trendData.filter(invitedTest).length;

  var stages = buildProgressTreeStages();
  if (!stages.length) {
    wrap.innerHTML = '<div class="empty" style="padding:20px 0;">「分類Result」工作表還沒有設定「階段」欄位，樹狀圖暫時無法顯示，請參考先前討論的分類方式填寫</div>';
    return;
  }

  var rootHtml = '<div class="tree-h-root"><div class="metric" style="cursor:pointer;min-width:140px;text-align:center;" onclick="showProgressTreeDrilldown('+rootIdx+')">'+
    '<div class="metric-top" style="justify-content:center;"><div class="metric-dot" style="background:#4F46E5"></div><span class="metric-label">邀約</span></div>'+
    '<div class="metric-val">'+invitedCount+'</div>'+
  '</div></div>';

  // 「其他」是獨立分支（例如待確認/暫緩），跟前面錄取階段等主流程沒有先後關係，中間不畫箭頭
  var stagesHtml = stages.map(function(s){
    var stageResults = s.results;
    var stageTotal = trendData.filter(function(d){ return stageResults.indexOf(d.Result) >= 0; }).length;
    var showArrow = s.stage !== '其他';

    var idx0 = _progressTreeDrilldown.length;
    _progressTreeDrilldown.push({ label: s.stage, test: function(d){ return stageResults.indexOf(d.Result) >= 0; } });

    // 重點放大：階段的總人數（次要才是進行中／已結案這些子分類，字放小、上下排列）
    var subItemsHtml = s.subGroups.length ? s.subGroups.map(function(sub){
      var idx = _progressTreeDrilldown.length;
      _progressTreeDrilldown.push({ label: s.stage+'－'+sub.label, test: function(d){ return sub.results.indexOf(d.Result) >= 0; }, resultValues: sub.results.slice() });
      var n = trendData.filter(function(d){ return sub.results.indexOf(d.Result) >= 0; }).length;
      return '<div class="metric metric-sm" style="cursor:pointer;" onclick="showProgressTreeDrilldown('+idx+')">'+
        '<div class="metric-top"><span class="metric-label">'+sub.label+'</span></div>'+
        '<div class="metric-val">'+n+'</div>'+
      '</div>';
    }).join('') : '';

    return (showArrow ? '<div class="tree-h-arrow">→</div>' : '<div class="tree-h-gap"></div>')+
      '<div class="tree-h-stage">'+
        '<div class="tree-h-stage-label">'+s.stage+'</div>'+
        '<div class="tree-h-stage-total" style="cursor:pointer;" onclick="showProgressTreeDrilldown('+idx0+')">'+stageTotal+'<span class="tree-h-stage-total-unit">人</span></div>'+
        (subItemsHtml ? '<div class="tree-h-stage-items">'+subItemsHtml+'</div>' : '')+
      '</div>';
  }).join('');

  wrap.innerHTML = rootHtml + stagesHtml;
}

// 階段轉換率漏斗圖：直接依「里程碑欄位是否有值」判斷每個人是否到達該階段，
// 邀約＝invite_date有值；電訪＝Phone Interview Scheduled有值；面試＝Interview Scheduled有值；錄取＝Hired date有值
// （Phone/Interview Scheduled、Hired date 都是後端在對應欄位變動時自動蓋上當天日期，等於「曾到達該階段」的累計記錄）
function renderStageConversionFunnel(trendData) {
  var wrap = document.getElementById('stageConversionFunnel');
  if (!wrap) return;
  var hasVal = function(v){ return !!(v && String(v).trim()); };
  var steps = [
    { label:'邀約', count: trendData.filter(function(d){ return hasVal(d.invite_date || d['invite date']); }).length },
    { label:'電訪', count: trendData.filter(function(d){ return hasVal(d['Phone Interview Scheduled']); }).length },
    { label:'面試', count: trendData.filter(function(d){ return hasVal(d['Interview Scheduled']); }).length },
    { label:'錄取', count: trendData.filter(function(d){ return hasVal(d['Hired date']); }).length }
  ];
  var invitedCount = steps[0].count;
  if (!invitedCount) {
    wrap.innerHTML = '<div class="empty" style="padding:10px 0;">尚無足夠資料計算轉換率</div>';
    return;
  }
  var rows = steps.map(function(s, i){
    var pct = Math.round(s.count/invitedCount*1000)/10;
    var prevCount = i === 0 ? null : steps[i-1].count;
    var step = prevCount ? Math.round(s.count/prevCount*1000)/10 : null;
    return { label: s.label, count: s.count, pct: pct, step: step, isFirst: i === 0 };
  });
  // 傳統漏斗圖：每階段一個梯形，上下緊密相連（不留縫隙），由寬到窄逐漸收攏，梯形裡放階段名稱＋人數（白字）；
  // 轉換率是重點，改放在圖形「右側」用跟該階段同色的大字顯示（呼應參考圖的排版，但不用圖示、顏色也收斂成同一色系）；
  // 該階段人數為 0 時，色塊改成灰色空白、右側轉換率也改用灰色，不會誤導視覺
  var FUNNEL_COLORS = ['#4338CA','#4F46E5','#6366F1','#818CF8'];
  var EMPTY_FILL = '#E8EAED', EMPTY_TEXT = '#9CA3AF';
  var chartW = 320, segH = 64;
  var chartH = segH * rows.length;
  var cx = chartW/2;
  var svgBody = rows.map(function(r, i){
    var y0 = i*segH, y1 = y0+segH, midY = y0+segH/2;
    var hasData = r.count > 0;
    var topPct = i === 0 ? 100 : rows[i-1].pct;
    var topW = Math.max(chartW * (topPct/100), 30);
    var botW = Math.max(chartW * (r.pct/100), 30);
    var points = (cx-topW/2)+','+y0+' '+(cx+topW/2)+','+y0+' '+(cx+botW/2)+','+y1+' '+(cx-botW/2)+','+y1;
    var fill = hasData ? FUNNEL_COLORS[i % FUNNEL_COLORS.length] : EMPTY_FILL;
    var textColor = hasData ? '#fff' : EMPTY_TEXT;
    var texts = '<text x="'+cx+'" y="'+(midY-2)+'" font-size="14" font-weight="700" fill="'+textColor+'" text-anchor="middle">'+r.label+'</text>'+
      '<text x="'+cx+'" y="'+(midY+14)+'" font-size="10" fill="'+textColor+'" text-anchor="middle">'+r.count+' 人</text>';
    return '<polygon points="'+points+'" fill="'+fill+'"></polygon>'+texts;
  }).join('');
  var svg = '<svg width="100%" height="'+chartH+'" viewBox="0 0 '+chartW+' '+chartH+'" preserveAspectRatio="xMidYMid meet">'+svgBody+'</svg>';

  var pctsHtml = rows.map(function(r, i){
    if (r.isFirst) return '<div class="funnel-pct-cell"></div>'; // 邀約一定是 100%，不用再顯示轉換率
    var hasData = r.count > 0;
    // 其餘階段用「占上一階段」轉換率，若剛好前一階段是 0（理論上不會有這階段）就退回用占邀約比例，避免顯示 null
    var displayPct = r.step !== null ? r.step : r.pct;
    var color = hasData ? FUNNEL_COLORS[i % FUNNEL_COLORS.length] : EMPTY_TEXT;
    return '<div class="funnel-pct-cell" style="color:'+color+';">'+displayPct+'%</div>';
  }).join('');

  wrap.innerHTML = '<div class="funnel-wrap" style="height:'+chartH+'px;">'+
    '<div class="funnel-chart">'+svg+'</div>'+
    '<div class="funnel-pcts">'+pctsHtml+'</div>'+
  '</div>';
}

// 進入下一階段平均天數：同一人前後兩個里程碑欄位（都有填值時）相減取天數再平均，樣本不足時顯示「—」
function renderStageConversionDays(trendData) {
  var wrap = document.getElementById('stageConversionDays');
  if (!wrap) return;
  var transitions = [
    { label:'邀約 → 電訪', from: function(d){ return d.invite_date || d['invite date']; }, to: function(d){ return d['Phone Interview Scheduled']; } },
    { label:'電訪 → 面試', from: function(d){ return d['Phone Interview Scheduled']; }, to: function(d){ return d['Interview Scheduled']; } },
    { label:'面試 → 錄取', from: function(d){ return d['Interview Scheduled']; }, to: function(d){ return d['Hired date']; } }
  ];
  var rows = transitions.map(function(t){
    var diffs = [];
    trendData.forEach(function(d){
      var fromDate = parseDateTime(t.from(d));
      var toDate = parseDateTime(t.to(d));
      if (fromDate && toDate) {
        var days = Math.round((toDate - fromDate) / 86400000);
        if (days >= 0) diffs.push(days);
      }
    });
    var avg = diffs.length ? Math.round(diffs.reduce(function(a,b){ return a+b; }, 0) / diffs.length * 10) / 10 : null;
    return { label: t.label, avg: avg, n: diffs.length };
  });
  wrap.innerHTML = rows.map(function(r){
    return '<div class="metric" style="display:flex;align-items:center;justify-content:space-between;">'+
      '<div class="metric-label">'+r.label+'</div>'+
      '<div class="metric-val">'+(r.avg === null ? '—' : r.avg)+(r.avg !== null ? '<span style="font-size:13px;font-weight:500;color:var(--text-tertiary);margin-left:2px;">天</span>' : '')+'</div>'+
    '</div>';
  }).join('<div style="height:8px;"></div>');
}

function showTrendDrilldown(title, records) {
  document.getElementById('trendDrilldownTitle').textContent = title + '（共 '+records.length+' 人）';
  var listEl = document.getElementById('trendDrilldownList');
  listEl.innerHTML = records.length === 0 ? '<div class="empty" style="padding:16px 0;">目前無資料</div>' :
    records.map(function(d){
      return '<div class="mini-card"><div class="mini-card-top"><div class="mini-card-name">'+(d.Name||'')+'</div><div class="mini-card-bu">'+(d['單位']||'')+'</div></div>'+
        '<div class="mini-card-pos">'+(d['Job Function']||'')+(d.Source?' · '+d.Source:'')+'</div>'+
        '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">目前狀態：'+(d.Result||'—')+'</div></div>';
    }).join('');
  document.getElementById('trendDrilldownModal').style.display = 'flex';
}
function closeTrendDrilldown() {
  document.getElementById('trendDrilldownModal').style.display = 'none';
}

// 各單位 Headcount（缺額）長條圖：依目前 tr-bu／tr-job 篩選統計 Headcount Records 裡尚未遞補的缺額數
function renderTrendHcChart() {
  var el = document.getElementById('trendHcChart');
  if (!el) return;
  if (!hcRawData || !hcRawData.length) { el.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">尚無 Headcount 資料</div>'; return; }
  var divKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Division';}) || 'Division';
  var jobKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Job Function';}) || 'Job Function';
  var succKey = Object.keys(hcRawData[0]).find(function(k){return k.includes('Successor')||k.trim()==='遞補人員';}) || 'Successor';
  var counts = {};
  hcRawData.forEach(function(r){
    var div = String(r[divKey]||'').trim();
    if (!div) return;
    if (!multiFilterPass('tr-bu', div)) return;
    if (!multiFilterPassMulti('tr-job', r[jobKey])) return;
    var succ = String(r[succKey]||'').trim();
    if (succ) return; // 只算尚未遞補的缺額
    counts[div] = (counts[div]||0) + 1;
  });
  var arr = Object.keys(counts).map(function(k){return {label:k, count:counts[k]};}).sort(function(a,b){return b.count-a.count;});
  if (!arr.length) { el.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">目前無缺額資料</div>'; return; }
  var maxVal = Math.ceil(Math.max.apply(null, arr.map(function(a){return a.count;}))*1.2) || 1;
  drawChart('trendHcChart', 'bar', arr.map(function(a){return a.label;}), [{name:'缺額', data:arr.map(function(a){return a.count;})}], maxVal);
}

function renderTrends() {
  var trBuOptions = [...new Set(allData.map(function(d){return String(d['單位']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('trBuBar', 'tr-bu', trBuOptions);
  var trJobOptions = buildMultiValueOptions(allData, function(d){return d['Job Function'];});
  renderMultiFilterBar('trJobBar', 'tr-job', trJobOptions);
  renderMultiFilterDropdown('trResultBar', 'tr-result', getResultOptions(), '目前狀態');

  var trendData = allData.filter(function(d){
    return multiFilterPass('tr-bu', d['單位']) &&
           multiFilterPassMulti('tr-job', d['Job Function']) &&
           multiFilterPass('tr-result', d.Result) &&
           dateFilterPass('trends', d);
  });
  lastTrendData = trendData;

  // ---- 人選進度統計（橫向樹狀圖，依「分類Result」工作表動態產生）----
  renderProgressTree(trendData);

  // ---- 階段轉換率（漏斗圖 + 各階段平均天數，沿用上方相同的單位/職務別/目前狀態篩選）----
  renderStageConversionFunnel(trendData);
  renderStageConversionDays(trendData);

  // ---- 各單位 Headcount（缺額）----
  renderTrendHcChart();

  // ---- 每月 Headcount & Onboard（最近 6 個月）：Headcount 固定長條、Onboard 固定折線 ----
  var monthly = computeMonthlyHeadcountOnboard();
  var monthlyMax = 1;
  monthly.series.forEach(function(s){ s.data.forEach(function(v){ if(v>monthlyMax) monthlyMax=v; }); });
  monthlyMax = Math.ceil(monthlyMax*1.2);
  drawComboBarLineChart('trendMonthlyChart', monthly.labels, monthly.series[0], monthly.series[1], monthlyMax);
  drawTrendTable('trendMonthlyTableHead','trendMonthlyTableBody', monthly.labels, monthly.series, 'monthly');
}

// ===== 資料維護 =====
// ===== 資料維護 =====
var maintainSheet = 'Candidate Records';
var maintainHeaders = {};
var maintainBU = 'all';
// candFilterBU/Job/Result 已改用 multiFilterState（cand-bu / cand-job / cand-result）
// salaryBU/salaryJob 已改用 multiFilterState（salary-bu / salary-job）

// 備用清單：只有在「分類Result」工作表讀不到（或欄位是空的）時才會用到，內容需跟「分類Result」工作表的
// 「Result」欄位保持一致（2026/07 對齊，共19項），避免備援清單跟正式分類對不起來
var FALLBACK_RESULT_OPTIONS = ['104已邀約未回覆','已致電未接','其他主管/近期已邀約','人選婉拒電訪','已關閉履歷','不建議邀約','待確認/暫緩','排電訪','待電訪','確認主管面試意願','排面試','待面試','已面試，排複試','確認主管錄取意願','確認人選錄取意願','錄取','未錄取','婉拒 Offer','婉拒面試'];

// Result 選項一律以 Google 試算表 Candidate Records 的「Result」欄位資料驗證規則為主，若讀不到才用備用清單
// ============================================================
// ===== 通用多選篩選元件（全站篩選都共用：可複選、有全選／取消全選）=====
// ============================================================
var multiFilterState = {}; // { filterId: { selected:Set, known:Set } }
var MULTI_FILTER_RERENDER = {}; // filterId -> 對應要重新渲染的畫面函式

function registerMultiFilterRerender(filterId, fn) {
  MULTI_FILTER_RERENDER[filterId] = fn;
}

function ensureMultiFilterState(filterId, options) {
  if (!multiFilterState[filterId]) {
    multiFilterState[filterId] = { selected: new Set(options), known: new Set(options) };
  } else {
    var state = multiFilterState[filterId];
    var optionSet = new Set(options);
    // 新出現的選項預設打勾（顯示），不會因為新增了選項就突然被濾掉
    options.forEach(function(o){
      if (!state.known.has(o)) { state.known.add(o); state.selected.add(o); }
    });
    // 消失的選項（該分類已經沒有任何資料）從清單移除，避免篩選卡住
    state.known.forEach(function(o){
      if (!optionSet.has(o)) { state.known.delete(o); state.selected.delete(o); }
    });
  }
  return multiFilterState[filterId];
}

// 判斷某筆資料的欄位值是否通過篩選；全選狀態下（包含尚未初始化）一律通過，含空白值
function multiFilterPass(filterId, rawValue) {
  var state = multiFilterState[filterId];
  if (!state) return true;
  if (state.selected.size >= state.known.size) return true;
  if (state.selected.size === 0) return true; // 這個維度全部取消勾選時，視為「不篩選這個欄位」，不要連帶擋掉其他篩選條件
  return state.selected.has(String(rawValue||'').trim());
}

// Inviter 欄位可能存多人（用「、」分隔），篩選時只要其中一位符合勾選條件就算通過
function multiFilterPassMulti(filterId, rawValue) {
  var state = multiFilterState[filterId];
  if (!state) return true;
  if (state.selected.size >= state.known.size) return true;
  if (state.selected.size === 0) return true; // 同上：全部取消勾選視為不篩選，不擋其他條件
  var parts = String(rawValue||'').split('、').map(function(s){return s.trim();}).filter(Boolean);
  return parts.some(function(p){ return state.selected.has(p); });
}

function renderMultiFilterBar(containerId, filterId, options) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var state = ensureMultiFilterState(filterId, options);
  var allSelected = state.selected.size >= state.known.size;
  var html = '<button class="filter-selectall-btn" onclick="toggleMultiFilterAll(\''+filterId+'\')">'+(allSelected?'取消全選':'全選')+'</button>';
  html += options.map(function(o){
    var active = state.selected.has(o);
    return '<button class="pos-btn'+(active?' active':'')+'" data-val="'+String(o).replace(/"/g,'&quot;')+'" onclick="toggleMultiFilterOption(\''+filterId+'\',this.getAttribute(\'data-val\'))">'+o+'</button>';
  }).join('');
  el.innerHTML = html;
}

// 下拉式多選（給選項較多的篩選用，例如「目前狀態」，避免按鈕排一長排）
var msDropdownOpenState = {};

function toggleMsDropdownPanel(containerId) {
  msDropdownOpenState[containerId] = !msDropdownOpenState[containerId];
  var panel = document.getElementById(containerId+'-panel');
  if (panel) panel.style.display = msDropdownOpenState[containerId] ? 'block' : 'none';
}

function renderMultiFilterDropdown(containerId, filterId, options, labelPrefix) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var state = ensureMultiFilterState(filterId, options);
  var allSelected = state.selected.size >= state.known.size;
  var summary = allSelected ? '全部' : (state.selected.size === 0 ? '未選擇' : state.selected.size + ' 項');
  var isOpen = !!msDropdownOpenState[containerId];

  var optionsHtml = options.map(function(o){
    var checked = state.selected.has(o);
    var oSafe = String(o).replace(/"/g,'&quot;');
    return '<label class="ms-dropdown-option"><input type="checkbox" '+(checked?'checked':'')+' data-val="'+oSafe+'" onchange="toggleMultiFilterOption(\''+filterId+'\',this.getAttribute(\'data-val\'))"> '+o+'</label>';
  }).join('');

  el.className = 'ms-dropdown';
  el.innerHTML =
    '<button type="button" class="ms-dropdown-toggle" onclick="toggleMsDropdownPanel(\''+containerId+'\')">'+labelPrefix+'：'+summary+' <span class="ms-dropdown-caret">▾</span></button>'+
    '<div class="ms-dropdown-panel" id="'+containerId+'-panel" style="display:'+(isOpen?'block':'none')+';">'+
      '<button type="button" class="filter-selectall-btn" style="display:block;width:100%;text-align:left;margin-bottom:6px;" onclick="toggleMultiFilterAll(\''+filterId+'\')">'+(allSelected?'取消全選':'全選')+'</button>'+
      optionsHtml+
    '</div>';
}

document.addEventListener('click', function(e){
  // 用 composedPath() 取得事件「原始」傳遞路徑：即使點擊當下的 handler
  // 把該節點的 innerHTML 整個重繪、讓原本被點的節點從 DOM 上被移除，
  // 這個路徑仍然正確，不會像 e.target.closest() 那樣因為節點已被移除
  // 而找不到父層、誤判成「點在下拉選單外面」導致選單被瞬間關閉。
  var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  var clickedInsideDropdown = path.some(function(node){
    return node.classList && node.classList.contains('ms-dropdown');
  });
  if (!clickedInsideDropdown) {
    Object.keys(msDropdownOpenState).forEach(function(id){
      if (msDropdownOpenState[id]) {
        msDropdownOpenState[id] = false;
        var panel = document.getElementById(id+'-panel');
        if (panel) panel.style.display = 'none';
      }
    });
  }
});

function toggleMultiFilterOption(filterId, val) {
  var state = multiFilterState[filterId];
  if (!state) return;
  if (state.selected.has(val)) state.selected.delete(val); else state.selected.add(val);
  var fn = MULTI_FILTER_RERENDER[filterId];
  if (fn) fn();
}

function toggleMultiFilterAll(filterId) {
  var state = multiFilterState[filterId];
  if (!state) return;
  var allSelected = state.selected.size >= state.known.size;
  if (allSelected) state.selected.clear();
  else state.known.forEach(function(o){ state.selected.add(o); });
  var fn = MULTI_FILTER_RERENDER[filterId];
  if (fn) fn();
}

// Result 選項嚴格只來自「分類Result」工作表的「Result」欄位（找不到工作表時才退回 FALLBACK_RESULT_OPTIONS）。
// 不再額外把資料裡實際出現過、但不在清單中的舊值加進選項——這樣所有畫面的 Result 選項才會跟工作表完全一致。
// 個別人選若剛好是這種不在清單內的舊值，該筆資料自己的編輯欄位仍會正常顯示與保留（buildDropdownSelectInput
// 內建了「目前值不在選項裡就補插一個」的保險機制），只是不會出現在共用的下拉選單／篩選清單裡。
function getResultOptions() {
  return (resultOptions && resultOptions.length) ? resultOptions.slice() : FALLBACK_RESULT_OPTIONS.slice();
}

// 資料維護畫面專用：編輯人選資料時的 Result 下拉選單。
// 統一改用跟篩選欄一樣的 getResultOptions()（來源是「分類Result」工作表），
// 這樣即使某個 Result 分類目前還沒有任何人選用過，也一樣能被選到，不會漏選項。
function getActualResultOptions() {
  return getResultOptions();
}

// 104_Position 選項：優先用試算表的資料驗證清單（可能列出還沒被用過的職缺），
// 同時保險加入實際資料裡出現過的值，確保兩邊都不會漏
function getPositionOptions() {
  var base = positionOptions && positionOptions.length ? positionOptions.slice() : [];
  var actualValues = [...new Set(allData.map(function(d){ return String(d['104_Position']||'').trim(); }))].filter(Boolean);
  actualValues.forEach(function(v){ if (base.indexOf(v) < 0) base.push(v); });
  return base;
}

// Headcount Records 各欄位的下拉選單選項（來自試算表的資料驗證規則，fetchData 時載入）
var headcountDropdownData = {};
function rebuildHeadcountDropdowns() {
  var map = {};
  Object.keys(headcountDropdownData).forEach(function(field){
    map[field] = function(){ return headcountDropdownData[field] || []; };
  });
  MAINTAIN_DROPDOWNS['Headcount Records'] = map;
}

// 哪些欄位是下拉選單
var MAINTAIN_DROPDOWNS = {
  'Candidate Records': {
    '單位': function(){ return [...new Set(allData.map(function(d){return String(d['單位']||'').trim();}))].filter(Boolean).sort(); },
    // Job Function 可能多選（用「、」分隔存多個值），選項要拆開顯示，不要把整串「A、B、C」當成一個選項（比照下面 Source 的做法）
    'Job Function': function(){ return buildMultiValueOptions(allData, function(d){return d['Job Function'];}); },
    '104_Position': function(){ return getPositionOptions(); },
    'Source': function(){ return [...new Set(allData.flatMap(function(d){return String(d.Source||'').split('、').map(function(s){return s.trim();});}))].filter(Boolean).sort(); },
    // Inviter：選項改抓 Manager Information 工作表的 Name 欄位（不是只抓歷史上打過的值），
    // 且只顯示跟這筆人選同單位的人（單位可能複選，符合其中一個單位即算）；
    // 如果目前還不知道單位（例如新增人選表單一開始還沒選單位）或該單位在 Manager Information 裡查不到人，
    // 就先列出全部人，避免選單被篩到空的、反而選不到人。
    'Inviter': function(unit){
      var units = splitMultiValue(unit);
      var pool = managerInfoData;
      if (units.length) {
        var filtered = managerInfoData.filter(function(m){ return units.indexOf(String(m.BU||'').trim()) >= 0; });
        if (filtered.length) pool = filtered;
      }
      return [...new Set(pool.map(function(m){return String(m.Name||'').trim();}))].filter(Boolean).sort();
    },
    // 面試主管：跟 Inviter 一樣可能不只一位，但選項直接抓 Manager Information 工作表的 Name 欄位（而非只抓已經用過的值）
    '面試主管': function(){ return [...new Set(managerInfoData.map(function(m){return String(m.Name||'').trim();}))].filter(Boolean).sort(); },
    'Result': function(){ return getActualResultOptions(); },
    '性別': function(){ return [...new Set(allData.map(function(d){return String(d['性別']||'').trim();}))].filter(Boolean).sort(); },
    '最高學歷': function(){ return [...new Set(allData.map(function(d){return String(d['最高學歷']||'').trim();}))].filter(Boolean).sort(); },
    // 負責HR：選項對照「HR Directory」工作表（權限管理裡設定的 HR 名冊），而不是抓歷史上打過的值，
    // 避免打字不一致或人員異動後名單對不起來；舊資料裡已經填過、但目前不在名冊裡的名字，畫面上仍會顯示並保留勾選。
    '負責HR': function(){ return hrDirectoryData.map(function(h){return String(h['HR姓名']||'').trim();}).filter(Boolean).sort(); },
    '婉拒理由': function(){ return [...new Set(allData.map(function(d){return String(d['婉拒理由']||'').trim();}))].filter(Boolean).sort(); },
    '是否邀約': function(){
      var base = ['是','否'];
      var actual = [...new Set(allData.map(function(d){return String(d['是否邀約']||'').trim();}))].filter(Boolean);
      actual.forEach(function(v){ if (base.indexOf(v) < 0) base.push(v); });
      return base;
    }
  },
  'Headcount Records': {}
};

// 負責HR：因為目前沒有登入機制，改用瀏覽器 localStorage 記住「這台瀏覽器最近一次填寫的負責HR」，
// 讓同一位 HR 只要打過一次名字，之後新增人選時就會自動帶入，不用每次重打
var LAST_HR_STORAGE_KEY = 'wt_recruitment_last_hr';
function getLastUsedHR() {
  try { return localStorage.getItem(LAST_HR_STORAGE_KEY) || ''; } catch(e) { return ''; }
}
function saveLastUsedHR(name) {
  try { if (name) localStorage.setItem(LAST_HR_STORAGE_KEY, name); } catch(e) {}
}

var MAINTAIN_DATE_FIELDS = ['invite_date','invite date','Phone Interview_date','Interview_date','Phone Interview Scheduled','Interview Scheduled','Result Update_date','Update_date','Update date','Onboard date','Hired date'];
var MAINTAIN_DATEONLY_FIELDS = ['invite_date','invite date','Phone Interview Scheduled','Interview Scheduled','Result Update_date','Update_date','Update date','Onboard date','Requisition Date','Hired date'];
var SCHEDULED_DATE_FIELD_MAP = {
  'Phone Interview_date': 'Phone Interview Scheduled',
  'Interview_date': 'Interview Scheduled'
};

// 判斷一個字串看起來像不像日期（要有 yyyy/mm/dd 或 mm/dd 這種數字＋分隔符號的樣式），
// 跟 normalizeDateForSave 用的日期偵測邏輯一致；打了「取消」之類的純文字會回傳 false。
function looksLikeDateStr(val) {
  var s = String(val||'').trim();
  if (!s) return false;
  return /(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})/.test(s);
}

// 將使用者輸入的日期字串正規化為儲存格式；輸入僅「6/30」時自動補上今年年份
function normalizeDateForSave(field, raw) {
  raw = String(raw||'').trim();
  if (!raw) return raw;
  var isDateOnly = MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0;
  var isDateTime = MAINTAIN_DATE_FIELDS.indexOf(field) >= 0 && !isDateOnly;
  var now = new Date();
  if (isDateOnly) return fmtDateOnly(raw);
  if (isDateTime) {
    if (raw.includes('整天')) {
      var dmAD = raw.match(/(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})/);
      if (dmAD) {
        var yrAD = dmAD[1] ? dmAD[1] : now.getFullYear();
        return yrAD+'/'+String(parseInt(dmAD[2])).padStart(2,'0')+'/'+String(parseInt(dmAD[3])).padStart(2,'0')+'整天';
      }
      return raw;
    }
    var periodMatch = raw.match(/(上午|中午|下午)/);
    var dm = raw.match(/(\d{4})?[\/\-]?(\d{1,2})[\/\-](\d{1,2})/);
    if (periodMatch && dm) {
      var yr = dm[1] ? dm[1] : now.getFullYear();
      return yr+'/'+String(parseInt(dm[2])).padStart(2,'0')+'/'+String(parseInt(dm[3])).padStart(2,'0')+' '+periodMatch[1];
    }
    var rangeMatch = raw.match(/(\d{1,2}):(\d{2})\s*[~\-–到至]\s*(\d{1,2}):(\d{2})/);
    if (rangeMatch) {
      var timeRangeStr = String(parseInt(rangeMatch[1])).padStart(2,'0')+':'+rangeMatch[2]+'~'+String(parseInt(rangeMatch[3])).padStart(2,'0')+':'+rangeMatch[4];
      if (dm) {
        var yrRR = dm[1] ? dm[1] : now.getFullYear();
        return yrRR+'/'+String(parseInt(dm[2])).padStart(2,'0')+'/'+String(parseInt(dm[3])).padStart(2,'0')+' '+timeRangeStr;
      }
      return timeRangeStr;
    }
    var tm = raw.match(/(\d{1,2}):(\d{2})/);
    if (dm && tm) {
      var yr2 = dm[1] ? dm[1] : now.getFullYear();
      return yr2+'/'+String(parseInt(dm[2])).padStart(2,'0')+'/'+String(parseInt(dm[3])).padStart(2,'0')+' '+String(parseInt(tm[1])).padStart(2,'0')+':'+tm[2];
    }
    if (dm) {
      var yr3 = dm[1] ? dm[1] : now.getFullYear();
      return yr3+'/'+String(parseInt(dm[2])).padStart(2,'0')+'/'+String(parseInt(dm[3])).padStart(2,'0');
    }
  }
  return raw;
}

function fmtDateOnly(s) {
  if (!s) return '';
  var raw = String(s).trim();
  var now = new Date();
  // 完整年/月/日
  var full = raw.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (full) return full[1]+'/'+String(parseInt(full[2])).padStart(2,'0')+'/'+String(parseInt(full[3])).padStart(2,'0');
  // 只有月/日，自動帶入今年
  var md = raw.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (md) return now.getFullYear()+'/'+String(parseInt(md[1])).padStart(2,'0')+'/'+String(parseInt(md[2])).padStart(2,'0');
  // 只有日，自動帶入今年今月
  var dOnly = raw.match(/^(\d{1,2})$/);
  if (dOnly) return now.getFullYear()+'/'+String(now.getMonth()+1).padStart(2,'0')+'/'+String(parseInt(dOnly[1])).padStart(2,'0');
  var d = new Date(raw);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
    return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0');
  }
  return raw;
}

// 資料維護畫面專用：時間欄位一律統一顯示成 YYYY/MM/DD HH:MM，不保留「整天／上午／中午／下午／時間區間」等原始文字。
// 換算規則跟系統排序邏輯（parseDateTime）一致：上午→08:00、中午→12:00、下午→13:00、整天／看不出時間→00:00
function fmtDateTimeStrict(s) {
  if (!s) return '';
  var d = parseDateTime(s);
  if (!d) return String(s).trim();
  return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}

async function switchMaintainSheet(sheetName, el) {
  maintainSheet = sheetName;
  maintainBU = 'all';
  document.querySelectorAll('#view-maintain .tab-bar .tab').forEach(function(t){t.classList.remove('active');});
  el.classList.add('active');
  document.getElementById('maintainCandidateView').style.display = sheetName==='Candidate Records' ? '' : 'none';
  document.getElementById('maintainHcView').style.display = sheetName!=='Candidate Records' ? '' : 'none';
  if (sheetName === 'Candidate Records') { ensureNewCandidateFieldsRendered(); renderCandQuery(); }
  else { await ensureResourceLoaded('headcount'); renderMaintain(); }
}

function getMaintainRecords(sheetName) {
  if (sheetName === 'Candidate Records') return allData;
  if (sheetName === 'Headcount Records') return hcRawData;
  if (sheetName === 'Market Salary Records') return salaryData;
  return [];
}

// ---- Candidate Records 查詢卡 ----
function findResumeCodeKey(rec) {
  return Object.keys(rec).find(function(k){return k.includes('履歷代碼');}) || '履歷代碼';
}

function isMultiFilterNarrowed(filterId) {
  var state = multiFilterState[filterId];
  if (!state) return false;
  return state.selected.size < state.known.size;
}

// 若目前正有資料維護的欄位在編輯中（游標還focus在某個儲存格），就先不要重新整個畫面重繪，
// 避免打到一半的內容被蓋掉、儲存格也跟著改變長寬。等使用者點開/離開該欄位後，下一次觸發時會照常重繪。
function isMaintainCellFocused(sheetName) {
  var ae = document.activeElement;
  if (!ae || !ae.getAttribute || !ae.hasAttribute('data-row')) return false;
  return sheetName ? ae.getAttribute('data-sheet') === sheetName : true;
}

// 支援一次打多個名字或履歷代碼查詢（用空白、逗號、頓號分隔），只要符合其中一個就算通過，方便一次查好幾位人選
function splitSearchTerms(search) {
  return String(search||'').split(/[\s,，、]+/).map(function(s){return s.trim().toLowerCase();}).filter(Boolean);
}
function matchesAnySearchTerm(text, terms) {
  var t = String(text||'').toLowerCase();
  return terms.some(function(term){ return t.includes(term); });
}

function renderCandQuery() {
  if (isMaintainCellFocused('Candidate Records')) return;
  renderSearchAllCandidatesResults(); // 跨單位搜尋結果（若目前有開啟）跟著搜尋框內容一起更新
  var search = (document.getElementById('candQuerySearch').value || '').trim().toLowerCase();
  var searchTerms = splitSearchTerms(search);
  var container = document.getElementById('candQueryResults');
  var hasDateFilter = dateFilterState.candidateMaintenance &&
    (dateFilterState.candidateMaintenance.start || dateFilterState.candidateMaintenance.end);

  var candBuOptions = [...new Set(allData.map(function(d){return String(d['單位']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('candBuBar', 'cand-bu', candBuOptions);
  var candJobOptions = buildMultiValueOptions(allData, function(d){return d['Job Function'];});
  renderMultiFilterBar('candJobBar', 'cand-job', candJobOptions);
  renderMultiFilterDropdown('candResultBar', 'cand-result', getActualResultOptions(), '目前狀態');
  var candInviterOptions = [...new Set(allData.flatMap(function(d){return String(d.Inviter||'').split('、').map(function(s){return s.trim();});}))].filter(Boolean).sort();
  renderMultiFilterDropdown('candInviterBar', 'cand-inviter', candInviterOptions, 'Inviter');

  // 單位／Job Function／目前狀態／Inviter 這四個屬於「篩選瀏覽」用途，才需要自動帶入本週；
  // 搜尋框（姓名／履歷代碼）屬於「找特定的人」，不管有沒有narrow這四項，都不套用時間篩選，避免篩不到人
  var hasOtherFilter = isMultiFilterNarrowed('cand-bu') || isMultiFilterNarrowed('cand-job') || isMultiFilterNarrowed('cand-result') || isMultiFilterNarrowed('cand-inviter');

  if (!searchTerms.length && !hasOtherFilter && !hasDateFilter) {
    container.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">請輸入姓名或履歷代碼查詢，或使用上方篩選條件顯示人選</div>';
    return;
  }

  // 使用者第一次真正套用「單位／Job Function／目前狀態／Inviter」篩選（不是搜尋文字），但還沒設定時間範圍時，
  // 自動補上「本週」再重新渲染一次；quickDateFilter 內部會自己觸發重新渲染，這裡直接 return 避免重複計算。
  // 但如果使用者已經按過「清除」，就尊重他的選擇，不要再自動補回本週；若是用搜尋框查人，則完全不自動補時間篩選。
  if (hasOtherFilter && !searchTerms.length && !hasDateFilter && !candMaintenanceDateCleared) {
    quickDateFilter('candidateMaintenance', 'thisWeek');
    return;
  }

  var matched = allData.filter(function(d){
    var resumeKey = findResumeCodeKey(d);
    var textMatch = !searchTerms.length || matchesAnySearchTerm(d.Name, searchTerms) || matchesAnySearchTerm(d[resumeKey], searchTerms);
    // 有輸入搜尋文字（姓名／履歷代碼）時，一律不套用時間篩選，確保只要有這個人就找得到，不受時間範圍限制
    var dateOk = searchTerms.length ? true : dateFilterPass('candidateMaintenance', d);
    return textMatch && multiFilterPass('cand-bu', d['單位']) && multiFilterPassMulti('cand-job', d['Job Function']) && multiFilterPass('cand-result', d.Result) && multiFilterPassMulti('cand-inviter', d.Inviter) && dateOk;
  });

  if (!matched.length) {
    container.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">找不到符合的人選</div>';
    return;
  }

  container.innerHTML = buildCandQueryCardsHtml(matched);
  container.querySelectorAll('textarea:not(.ta-scrollable)').forEach(autoGrowTextarea);
}

// 完整可編輯人選資料卡（含選取以複製／刪除按鈕）：資料維護的查詢結果、
// 以及 Candidate Overview 的「搜尋人選資料」都共用這一份卡片渲染邏輯
function buildCandQueryCardsHtml(matched) {
  return buildCandCardsHtmlInternal(matched, {
    idxOf: function(cand){ return allData.indexOf(cand); },
    showDelete: true,
    tagLabel: ''
  });
}

// 跨單位搜尋結果卡（「搜尋全部人選」顯示的其他單位資料）：欄位一樣可以直接編輯，
// 資料是從 allDataFull（不受目前身分單位範圍限制）取得，所以 idx 要用 allDataFull 的位置，
// 不能沿用 allData 的索引（這些紀錄本來就不在目前身分的 allData 範圍內）。
// 保留「選取以複製」，但不提供「刪除」——避免誤刪其他單位的資料。
function buildCrossUnitCandCardsHtml(matched) {
  return buildCandCardsHtmlInternal(matched, {
    idxOf: function(cand){ return allDataFull.indexOf(cand); },
    showDelete: false,
    tagLabel: ' <span style="font-size:11px;font-weight:600;color:var(--text-tertiary);">（其他單位）</span>'
  });
}

function buildCandCardsHtmlInternal(matched, opts) {
  return matched.map(function(cand){
    var idx = opts.idxOf(cand);
    var candHeaders = filterCandHeadersForMaintenance(maintainHeaders['Candidate Records'] || Object.keys(cand).filter(function(k){return k!=='_row';}));
    var isSelected = selectedCandForCopy && selectedCandForCopy._row === cand._row;

    var isPhoneRecordHeader = function(h){ return /phone\s*interview\s*record/i.test(h); };
    var phoneRecordFields = candHeaders.filter(isPhoneRecordHeader).sort(function(a,b){
      return (/hr/i.test(a)?0:1) - (/hr/i.test(b)?0:1); // HR 固定在左，主管固定在右
    });
    var pairedPhoneRecordDone = false;
    var fieldsHtml = candHeaders.map(function(h){
      if (isPhoneRecordHeader(h)) {
        if (pairedPhoneRecordDone) return ''; // 第二個欄位（不論是 HR 或主管，看誰先出現）已經跟第一個一起畫在同一排了
        pairedPhoneRecordDone = true;
        if (phoneRecordFields.length >= 2) {
          // 兩個欄位並排在同一整排：外層佔滿整排，裡面用兩欄各放一個
          var pairHtml = phoneRecordFields.map(function(pf){
            return renderQueryField('Candidate Records', cand, pf, idx, false, true);
          }).join('');
          return '<div style="grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:14px;">'+pairHtml+'</div>';
        }
        return renderQueryField('Candidate Records', cand, h, idx, true, true);
      }
      // 採緊湊欄寬，僅職缺名稱保留稍大空間；Memo 欄位改成跟下面「新增人選資料」一樣的全寬
      var isFullWidth = h.indexOf('Memo') >= 0;
      var isWide = h === '104_Position';
      // 時間欄位一律統一顯示成 YYYY/MM/DD HH:MM
      return renderQueryField('Candidate Records', cand, h, idx, isFullWidth ? true : (isWide ? 'span2' : false), true);
    }).join('');

    return '<div class="mini-card" style="padding:20px 22px;margin-bottom:16px;'+(isSelected?'border-color:var(--accent);box-shadow:0 0 0 2px var(--accent);':'')+'">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">'+
        '<div style="font-size:16px;font-weight:700;">'+cand.Name+(isSelected?' <span style="font-size:11px;font-weight:600;color:var(--accent);">（已選取，將用於複製）</span>':'')+(opts.tagLabel||'')+'</div>'+
        '<div style="display:flex;gap:8px;">'+
          (isSelected
            ? '<button class="refresh-btn" style="margin-left:0;color:var(--accent);border-color:var(--accent);" onclick="clearCandForCopy()">✕ 取消選取</button>'
            : '<button class="refresh-btn" style="margin-left:0;" onclick="selectCandForCopy('+cand._row+')">📌 選取以複製</button>')+
          (opts.showDelete ? '<button class="refresh-btn" style="margin-left:0;color:#EF4444;border-color:#EF4444;" onclick="deleteMaintainRow('+cand._row+')">🗑️ 刪除人選資料</button>' : '')+
        '</div>'+
      '</div>'+
      '<div class="maintain-candidate-grid">'+fieldsHtml+'</div>'+
    '</div>';
  }).join('');
}

// Candidate Overview 畫面的「搜尋人選資料」：比照資料維護的搜尋，輸入姓名或履歷代碼即顯示完整可編輯資料卡
function renderQueryField(sheetName, rec, field, idx, fullWidth, strictDateFormat) {
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var col = (maintainHeaders[sheetName] || Object.keys(rec)).indexOf(field) + 1;
  var dropdowns = MAINTAIN_DROPDOWNS[sheetName] || {};
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0;
  var displayVal = isDateOnlyField ? fmtDateOnly(rawVal) : isDateField ? (strictDateFormat ? fmtDateTimeStrict(rawVal) : fmtDate(rawVal)) : rawVal;
  var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');
  var wrapStyle = fullWidth === 'span2' ? 'grid-column:span 2;' : fullWidth ? 'grid-column:1/-1;' : '';
  var isPhoneRecordField = /phone\s*interview\s*record/i.test(field);
  var isLongTextField = field.indexOf('Memo') >= 0 || isPhoneRecordField;

  var inputHtml;
  if (dropdowns[field]) {
    // Inviter 需要依這筆人選目前的「單位」篩選（其餘欄位的下拉函式不吃參數，多傳這個沒有影響）
    var options = dropdowns[field](rec ? rec['單位'] : undefined);
    var fieldStyle = 'width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);box-sizing:border-box;';
    inputHtml = (sheetName === 'Candidate Records' && MULTI_SELECT_FIELDS.indexOf(field) >= 0)
      ? buildInviterMultiSelectInput(sheetName, rec, field, col, idx, options, fieldStyle)
      : (sheetName === 'Candidate Records' && STRICT_SELECT_FIELDS.indexOf(field) >= 0)
      ? buildDropdownSelectInput(sheetName, rec, field, col, idx, options, fieldStyle)
      : buildDropdownDatalistInput(sheetName, rec, field, col, idx, options, fieldStyle);
  } else if (isDateField) {
    // 日期欄位（invite_date／Phone Interview_date／Interview_date／Result Update_date／Onboard date）：
    // 點擊欄位或月曆圖示可直接跳出小月曆點選日期，選完自動存檔；欄位本身仍可手動輸入或補打時間文字。
    inputHtml = buildDateFieldInput(sheetName, rec, field, col, idx, displayVal, rawSafe);
  } else if (isLongTextField) {
    var taUid = 'ta_' + (_dlIdCounter++);
    // Phone Interview Record(HR)／(主管) 欄位內容常常越記越長，不要跟著內容自動一直長高（像 Memo 那樣），
    // 但也不要固定死高度——預設給一個不會太小的起始高度，使用者可以自己拖拉右下角調整要多高，
    // 拉的高度不夠時欄位本身還是能上下捲動看完整內容（textarea 原生行為）。
    inputHtml = '<textarea id="'+(isPhoneRecordField?taUid:'')+'" class="'+(isPhoneRecordField?'ta-scrollable':'')+'" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
      'onfocus="this.dataset.original=this.value;'+(isPhoneRecordField?'initTextHistoryOnFocus(this);':'')+'" onblur="commitMaintainTextarea(this)" oninput="'+(isPhoneRecordField?'recordTextHistory(this);':'autoGrowTextarea(this);')+'" rows="2" '+
      'style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;resize:vertical;font-family:inherit;white-space:pre-wrap;word-break:break-word;'+
      (isPhoneRecordField ? 'min-height:70px;' : 'overflow:hidden;')+'">'+(rawVal||'')+'</textarea>';
    if (isPhoneRecordField) {
      inputHtml += '<div class="ta-history-toolbar">'+
        '<button type="button" onmousedown="event.preventDefault()" onclick="saveTextFieldNow(\''+taUid+'\')">💾 儲存</button>'+
        '<button type="button" onmousedown="event.preventDefault()" onclick="undoTextField(\''+taUid+'\')">↶ 上一步</button>'+
        '<button type="button" onmousedown="event.preventDefault()" onclick="redoTextField(\''+taUid+'\')">↷ 下一步</button>'+
      '</div>';
    }
  } else {
    inputHtml = '<textarea data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
      'onfocus="enterMaintainEditTA(this)" onblur="commitMaintainCellTA(this)" rows="2" '+
      'style="width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);min-height:36px;box-sizing:border-box;resize:vertical;font-family:inherit;white-space:pre-wrap;word-break:break-word;">'+
      (displayVal||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</textarea>';
  }

  return '<div style="'+wrapStyle+'"><div style="font-size:10px;font-weight:600;color:var(--text-tertiary);margin-bottom:4px;">'+field+'</div>'+inputHtml+'</div>';
}

async function commitMaintainTextarea(el) {
  var newVal = el.value.trim();
  var original = el.dataset.original || '';
  if (newVal === original) return;
  await saveMaintainField(el.getAttribute('data-sheet'), el.getAttribute('data-row'), el.getAttribute('data-col'), el.getAttribute('data-field'), parseInt(el.getAttribute('data-idx')), newVal);
}

// Phone Interview Record(HR)／(主管) 專用：獨立的「上一步／下一步」編輯歷史（跟瀏覽器原生的復原無關，
// 是打字打到一半、想退回前一版內容用的），加上一個明確的「儲存」按鈕；欄位本身的自動存檔（離開欄位就存）維持不變。
var _textHistoryMap = {};    // uid -> {stack:[...每次修改後的完整內容], index:目前是第幾個版本}
var _textHistoryTimers = {}; // uid -> 記錄歷史用的防抖動計時器

// 欄位一得到焦點就先把「當下內容」存成歷史的第一筆，之後才有「上一步」可以退回
function initTextHistoryOnFocus(el) {
  if (!_textHistoryMap[el.id]) _textHistoryMap[el.id] = { stack: [el.value], index: 0 };
}

// 打字打到一半不要每個字都記一筆，停下來 0.8 秒後才記一筆版本，「上一步」才會是有意義的段落，不是一個字一個字退
function recordTextHistory(el) {
  var uid = el.id;
  if (!uid) return;
  clearTimeout(_textHistoryTimers[uid]);
  _textHistoryTimers[uid] = setTimeout(function(){
    if (!_textHistoryMap[uid]) _textHistoryMap[uid] = { stack: [el.value], index: 0 };
    var hist = _textHistoryMap[uid];
    if (hist.stack[hist.index] === el.value) return;
    hist.stack = hist.stack.slice(0, hist.index + 1); // 退回舊版本後又繼續打字，後面「下一步」的紀錄就不算數了
    hist.stack.push(el.value);
    hist.index = hist.stack.length - 1;
  }, 800);
}

async function applyTextHistoryValue(el, newVal) {
  el.value = newVal;
  autoGrowTextarea(el);
  el.dataset.original = newVal;
  el.setAttribute('data-raw', newVal);
  await saveMaintainField(el.getAttribute('data-sheet'), el.getAttribute('data-row'), el.getAttribute('data-col'), el.getAttribute('data-field'), parseInt(el.getAttribute('data-idx')), newVal);
}

function undoTextField(uid) {
  var el = document.getElementById(uid);
  if (!el) return;
  initTextHistoryOnFocus(el);
  var hist = _textHistoryMap[uid];
  if (hist.index <= 0) { showToast('已經是最早的版本了'); return; }
  hist.index--;
  applyTextHistoryValue(el, hist.stack[hist.index]);
}

function redoTextField(uid) {
  var el = document.getElementById(uid);
  if (!el) return;
  var hist = _textHistoryMap[uid];
  if (!hist || hist.index >= hist.stack.length - 1) { showToast('已經是最新的版本了'); return; }
  hist.index++;
  applyTextHistoryValue(el, hist.stack[hist.index]);
}

function saveTextFieldNow(uid) {
  var el = document.getElementById(uid);
  if (!el) return;
  var newVal = el.value.trim();
  initTextHistoryOnFocus(el);
  var hist = _textHistoryMap[uid];
  if (hist.stack[hist.index] !== newVal) {
    hist.stack = hist.stack.slice(0, hist.index + 1);
    hist.stack.push(newVal);
    hist.index = hist.stack.length - 1;
  }
  applyTextHistoryValue(el, newVal);
  showToast('✓ 已儲存');
}

// ---- Headcount Records 表格模式 ----
function maintainFilter(type, val, el) {
  if (type === 'bu') maintainBU = val;
  document.querySelectorAll('#maintainBuBar .bu-btn').forEach(function(b){b.classList.remove('active');});
  el.classList.add('active');
  renderMaintain();
}

function renderMaintain() {
  if (isMaintainCellFocused(maintainSheet)) return;
  var allRecords = getMaintainRecords(maintainSheet);
  var headers = maintainHeaders[maintainSheet] || (allRecords.length ? Object.keys(allRecords[0]).filter(function(k){return k!=='_row';}) : []);
  headers = headers.filter(function(h){ return !h.includes('PS'); });

  var buKey = headers.find(function(h){return h==='BU'||h==='Division'||h==='Company';});
  var buLabel = buKey === 'Company' ? '公司' : '單位';
  document.getElementById('maintainBuLabel').textContent = buLabel;
  if (buKey) {
    var bus = [...new Set(allRecords.map(function(r){return String(r[buKey]||'').trim();}))].filter(Boolean).sort();
    document.getElementById('maintainBuBar').innerHTML =
      '<button class="bu-btn '+(maintainBU==='all'?'active':'')+'" data-bu="all" onclick="maintainFilter(\'bu\',this.getAttribute(\'data-bu\'),this)">全部'+buLabel+'</button>'+
      bus.map(function(b){return '<button class="bu-btn '+(maintainBU===b?'active':'')+'" data-bu="'+b+'" onclick="maintainFilter(\'bu\',this.getAttribute(\'data-bu\'),this)">'+b+'</button>';}).join('');
  } else {
    document.getElementById('maintainBuBar').innerHTML = '<button class="bu-btn active">全部</button>';
  }

  var search = (document.getElementById('maintainSearch')?document.getElementById('maintainSearch').value:'').toLowerCase();
  var records = allRecords.filter(function(r){
    var buMatch = !buKey || maintainBU==='all' || String(r[buKey]||'').trim()===maintainBU;
    var searchMatch = !search || headers.some(function(h){return String(r[h]||'').toLowerCase().includes(search);});
    return buMatch && searchMatch;
  });

  if (!headers.length) {
    document.getElementById('maintainTableHead').innerHTML = '';
    document.getElementById('maintainTableBody').innerHTML = '<tr><td style="padding:20px;color:var(--text-tertiary);">尚無資料或欄位資訊</td></tr>';
    return;
  }

  document.getElementById('maintainTableHead').innerHTML =
    '<tr>' + headers.map(function(h){ return '<th style="white-space:nowrap;">'+h+'</th>'; }).join('') + '<th style="width:40px;"></th></tr>';

  document.getElementById('maintainTableBody').innerHTML = records.map(function(rec){
    var idx = allRecords.indexOf(rec);
    var cells = headers.map(function(h){
      var rawVal = rec[h] !== undefined ? rec[h] : '';
      var col = headers.indexOf(h) + 1;
      var isDateField = MAINTAIN_DATE_FIELDS.indexOf(h) >= 0;
      var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(h) >= 0;
      var displayVal = isDateOnlyField ? fmtDateOnly(rawVal) : isDateField ? fmtDate(rawVal) : rawVal;
      var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');

      return '<td contenteditable="true" data-sheet="'+maintainSheet+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+h+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
        'onfocus="enterMaintainEdit(this)" onblur="commitMaintainCell(this)" '+
        'style="min-width:90px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text;">'+
        (displayVal||'').toString().replace(/</g,'&lt;').replace(/>/g,'&gt;')+
        '</td>';
    }).join('');
    return '<tr>'+cells+'<td><button onclick="deleteMaintainRow('+rec._row+')" style="font-size:12px;color:#EF4444;background:none;border:none;cursor:pointer;padding:4px 8px;">✕</button></td></tr>';
  }).join('');
}

// ===== Market Salary Records（獨立畫面）=====
function renderSalaryScreen() {
  var headers = maintainHeaders['Market Salary Records'] || (salaryData.length ? Object.keys(salaryData[0]).filter(function(k){return k!=='_row';}) : []);

  var buKey = headers.find(function(h){return h==='BU'||h==='Company';});
  var buLabelEl = document.getElementById('salaryBuLabel');
  if (buLabelEl) buLabelEl.textContent = buKey === 'Company' ? '公司' : (buKey || '篩選');

  if (buKey) {
    var bus = [...new Set(salaryData.map(function(r){return String(r[buKey]||'').trim();}))].filter(Boolean).sort();
    renderMultiFilterBar('salaryBuBar', 'salary-bu', bus);
  } else {
    document.getElementById('salaryBuBar').innerHTML = '';
  }

  var jobKey = headers.find(function(h){return h==='Job Function';});
  if (jobKey) {
    var jobs = buildMultiValueOptions(salaryData, function(r){return r[jobKey];});
    renderMultiFilterBar('salaryJobBar', 'salary-job', jobs);
  } else {
    var jobBarEl = document.getElementById('salaryJobBar');
    if (jobBarEl) jobBarEl.innerHTML = '';
  }

  var search = (document.getElementById('salarySearch')?document.getElementById('salarySearch').value:'').toLowerCase();
  var records = salaryData.filter(function(r){
    var buMatch = !buKey || multiFilterPass('salary-bu', r[buKey]);
    var jobMatch = !jobKey || multiFilterPassMulti('salary-job', r[jobKey]);
    var searchMatch = !search || headers.some(function(h){return String(r[h]||'').toLowerCase().includes(search);});
    return buMatch && jobMatch && searchMatch;
  });

  if (!headers.length) {
    document.getElementById('salaryTableHead').innerHTML = '';
    document.getElementById('salaryTableBody').innerHTML = '<tr><td style="padding:20px;color:var(--text-tertiary);">尚無資料或欄位資訊</td></tr>';
    return;
  }

  document.getElementById('salaryTableHead').innerHTML =
    '<tr>' + headers.map(function(h){ return '<th style="white-space:nowrap;">'+h+'</th>'; }).join('') + '<th style="width:40px;"></th></tr>';

  document.getElementById('salaryTableBody').innerHTML = records.map(function(rec){
    var idx = salaryData.indexOf(rec);
    var cells = headers.map(function(h){
      return '<td style="padding:2px;">'+renderTableCellInput('Market Salary Records', rec, h, idx)+'</td>';
    }).join('');
    return '<tr>'+cells+'<td><button onclick="deleteSalaryRow('+rec._row+')" style="font-size:12px;color:#EF4444;background:none;border:none;cursor:pointer;padding:4px 8px;">✕</button></td></tr>';
  }).join('');
}

async function deleteSalaryRow(row) {
  if (!confirm('確定要刪除這一列嗎？此動作無法復原。')) return;
  var statusEl = document.getElementById('salaryStatus');
  if (statusEl) statusEl.textContent = '刪除中...';
  try {
    var url = APPS_SCRIPT_URL + '?action=deleteRow&sheet=' + encodeURIComponent('Market Salary Records') + '&row=' + encodeURIComponent(row);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'salary') renderSalaryScreen();
    if (statusEl) { statusEl.textContent = '✓ 已刪除'; setTimeout(function(){statusEl.textContent='';}, 2000); }
  } catch(e) {
    if (statusEl) statusEl.textContent = '❌ 刪除失敗：'+e.message;
  }
}

function ensureNewSalaryFieldsRendered() {
  var el = document.getElementById('newSalaryFields');
  if (el && !el.children.length) renderNewSalaryFields();
}

function renderNewSalaryFields() {
  var headers = maintainHeaders['Market Salary Records'] || (salaryData.length ? Object.keys(salaryData[0]).filter(function(k){return k!=='_row';}) : []);
  document.getElementById('newSalaryFields').innerHTML = headers.map(function(h){
    var isRequired = h === 'Company';
    var label = h + (isRequired ? ' <span style="color:#EF4444;">*</span>' : '');
    return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" class="new-salary-input" data-field="'+h+'" style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"></div>';
  }).join('');
}

async function submitNewSalaryRow() {
  var headers = maintainHeaders['Market Salary Records'] || [];
  var requiredFields = ['Company'];
  var values = {};
  var missing = [];
  document.querySelectorAll('#newSalaryFields .new-salary-input').forEach(function(inp){
    var field = inp.getAttribute('data-field');
    var val = inp.value.trim();
    if (val && (MAINTAIN_DATE_FIELDS.indexOf(field) >= 0 || MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0)) {
      val = normalizeDateForSave(field, val);
    }
    values[field] = val;
    if (requiredFields.indexOf(field) >= 0 && !val) missing.push(field);
  });
  if (missing.length) { showToast('請填寫必填欄位：'+missing.join('、')); return; }

  var orderedValues = headers.map(function(h){ return values[h] || ''; });
  showToast('新增中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('Market Salary Records') +
      '&values=' + encodeURIComponent(JSON.stringify(orderedValues));
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    renderNewSalaryFields();
    renderSalaryScreen();
    showToast('✓ 已新增一筆資料');
  } catch(e) {
    showToast('❌ 新增失敗：'+e.message);
  }
}

// ---- 共用：編輯/儲存 ----
function enterMaintainEdit(el) {
  var raw = el.getAttribute('data-raw') || '';
  var field = el.getAttribute('data-field');
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0;
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field) >= 0;
  // 編輯時一律顯示乾淨格式（例如 2026/07/03 13:30），不要出現 JS Date 原始字串（例如 Thu May 21 2026 00:00:00 GMT+0800）
  var editVal = isDateOnlyField ? fmtDateOnly(raw) : isDateField ? fmtDate(raw) : raw;
  el.dataset.original = editVal;
  el.textContent = editVal;
  var range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function saveMaintainField(sheet, row, col, field, idx, newVal) {
  document.getElementById('maintainStatus') && (document.getElementById('maintainStatus').textContent = '儲存中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=editCell&sheet=' + encodeURIComponent(sheet) +
      '&row=' + encodeURIComponent(row) + '&col=' + encodeURIComponent(col) + '&value=' + encodeURIComponent(newVal);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    var records = getMaintainRecords(sheet);
    var rec = records[idx];
    // 跨單位搜尋結果（其他單位的人選資料）不在目前身分的 allData 範圍內，idx 指的是 allDataFull 的位置，
    // 對 allData 來說會對不上（甚至是 undefined／別筆資料）；這裡用 _row 再保險比對一次，
    // 對不上就改用 allDataFull 找同一列的資料來更新記憶體，確保跨單位編輯後畫面／記憶體都正確同步。
    if (sheet === 'Candidate Records' && (!rec || String(rec._row) !== String(row))) {
      rec = allDataFull.find(function(d){ return String(d._row) === String(row); });
    }
    if (rec) {
      rec[field] = newVal;
      rememberRecentEdit(sheet, row, field, newVal); // 短時間內保護剛存的值，避免背景自動同步把它蓋回舊的
      // 跟後端一致：Candidate Records / Market Salary Records 只要有任何欄位被改動，畫面上也立即帶出今天的更新日期
      var updateFieldName = sheet === 'Candidate Records' ? 'Result Update_date' : (sheet === 'Market Salary Records' ? 'Update date' : null);
      if (updateFieldName && field !== updateFieldName) {
        var todayStr = getTodayDateStr();
        rec[updateFieldName] = todayStr;
        rememberRecentEdit(sheet, row, updateFieldName, todayStr);
        var updEl = document.querySelector('[data-sheet="'+sheet+'"][data-row="'+row+'"][data-field="'+updateFieldName+'"]');
        if (updEl) {
          updEl.setAttribute('data-raw', todayStr);
          if (updEl.tagName === 'SELECT' || updEl.tagName === 'INPUT' || updEl.tagName === 'TEXTAREA') updEl.value = todayStr;
          else updEl.textContent = fmtDateOnly(todayStr);
        }
      }
      // 更新面試日期時，同步帶入該次排程的更新日期；Apps Script 也會寫入試算表，
      // 此處同時更新記憶體資料與畫面，使用者不需要重新整理。
      // 但如果 Phone Interview_date／Interview_date 改成的新值不是日期格式（例如打了「取消」之類的文字），
      // 就不應該蓋 Scheduled 欄位的時間，跟後端 stampCandidateScheduledDate_ 的判斷邏輯一致。
      var scheduledFieldName = (sheet === 'Candidate Records' && looksLikeDateStr(newVal)) ? SCHEDULED_DATE_FIELD_MAP[field] : null;
      if (scheduledFieldName) {
        var scheduledToday = getTodayDateStr();
        rec[scheduledFieldName] = scheduledToday;
        rememberRecentEdit(sheet, row, scheduledFieldName, scheduledToday);
        var scheduledEl = document.querySelector('[data-sheet="'+sheet+'"][data-row="'+row+'"][data-field="'+scheduledFieldName+'"]');
        if (scheduledEl) {
          scheduledEl.setAttribute('data-raw', scheduledToday);
          if (scheduledEl.tagName === 'SELECT' || scheduledEl.tagName === 'INPUT' || scheduledEl.tagName === 'TEXTAREA') scheduledEl.value = scheduledToday;
          else scheduledEl.textContent = fmtDateOnly(scheduledToday);
        }
      }
      // Result 改成「錄取」時，同步帶入 Hired date 為今天（後端 stampHiredDate_ 也會寫回試算表）
      if (sheet === 'Candidate Records' && field === 'Result' && String(newVal||'').trim() === '錄取') {
        var hiredToday = getTodayDateStr();
        rec['Hired date'] = hiredToday;
        rememberRecentEdit(sheet, row, 'Hired date', hiredToday);
        var hiredEl = document.querySelector('[data-sheet="'+sheet+'"][data-row="'+row+'"][data-field="Hired date"]');
        if (hiredEl) {
          hiredEl.setAttribute('data-raw', hiredToday);
          if (hiredEl.tagName === 'SELECT' || hiredEl.tagName === 'INPUT' || hiredEl.tagName === 'TEXTAREA') hiredEl.value = hiredToday;
          else hiredEl.textContent = fmtDateOnly(hiredToday);
        }
      }
      // Headcount Records「遞補人員」姓名改變時，自動帶出 Candidate Records 相符姓名的 Onboard date；
      // 同名有多人時跳出選擇視窗讓使用者指定是哪一位
      if (sheet === 'Headcount Records' && String(field||'').trim() === '遞補人員') {
        handleHeadcountSuccessorNameChange(row, idx, newVal);
      }
    }
    showToast('✓ 已儲存');
    return true;
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
    return false;
  }
}

// Headcount Records「遞補人員」姓名比對 Candidate Records，自動帶出 Onboard date；
// 找不到符合姓名的人選就提醒手動填寫，找到超過一筆同名的人選就跳出選擇視窗讓使用者指定。
async function handleHeadcountSuccessorNameChange(row, idx, newVal) {
  var name = String(newVal||'').trim();
  var headers = maintainHeaders['Headcount Records'] || [];
  var onboardCol = headers.indexOf('Onboard date') + 1;
  if (onboardCol <= 0) return; // 試算表還沒有 Onboard date 欄位，無法自動帶出

  if (!name) {
    // 遞補人員清空時，同步清空 Onboard date，避免殘留舊資料
    await saveMaintainField('Headcount Records', row, onboardCol, 'Onboard date', idx, '');
    renderHeadcount();
    return;
  }

  var pool = (typeof allDataFull !== 'undefined' && allDataFull && allDataFull.length) ? allDataFull : allData;
  var matches = pool.filter(function(d){ return String(d.Name||'').trim() === name; });

  if (!matches.length) {
    showToast('找不到姓名為「'+name+'」的人選，Onboard date 需手動填寫');
    return;
  }
  if (matches.length === 1) {
    await saveMaintainField('Headcount Records', row, onboardCol, 'Onboard date', idx, matches[0]['Onboard date']||'');
    renderHeadcount();
    return;
  }
  openSuccessorPickerModal(row, idx, onboardCol, matches);
}

var _successorPickerState = null;
var _successorPickerMatches = [];
function openSuccessorPickerModal(row, idx, onboardCol, matches) {
  _successorPickerState = { row: row, idx: idx, onboardCol: onboardCol };
  _successorPickerMatches = matches;
  var listEl = document.getElementById('successorPickerList');
  listEl.innerHTML = matches.map(function(m, i){
    var resumeCode = m['履歷代碼'] || '';
    var unit = m['單位'] || '';
    var job = m['Job Function'] || '';
    var onboard = m['Onboard date'] ? fmtDateOnly(m['Onboard date']) : '尚未填寫到職日';
    var subInfo = [resumeCode, unit, job].filter(Boolean).join(' · ');
    return '<div class="mini-card" style="cursor:pointer;" onclick="selectSuccessorMatch('+i+')">'+
      '<div style="font-weight:700;font-size:13px;">'+(m.Name||'')+'</div>'+
      (subInfo ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">'+subInfo+'</div>' : '')+
      '<div style="font-size:12px;margin-top:4px;">Onboard date：'+onboard+'</div>'+
    '</div>';
  }).join('');
  document.getElementById('successorPickerModal').style.display = 'flex';
}
async function selectSuccessorMatch(i) {
  var m = _successorPickerMatches[i];
  var st = _successorPickerState;
  if (!m || !st) return;
  closeSuccessorPickerModal();
  await saveMaintainField('Headcount Records', st.row, st.onboardCol, 'Onboard date', st.idx, m['Onboard date']||'');
  renderHeadcount();
}
function closeSuccessorPickerModal() {
  var el = document.getElementById('successorPickerModal');
  if (el) el.style.display = 'none';
  _successorPickerState = null;
}

async function commitMaintainCell(el) {
  var newVal = el.textContent.trim();
  var original = el.dataset.original || '';
  var field0 = el.getAttribute('data-field');
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field0) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field0) >= 0;

  if (newVal === original) {
    if (isDateOnlyField) el.textContent = fmtDateOnly(newVal);
    else if (isDateField) el.textContent = fmtDate(newVal);
    return;
  }

  if (newVal && (isDateField || isDateOnlyField)) newVal = normalizeDateForSave(field0, newVal);

  var sheet = el.getAttribute('data-sheet');
  var row = el.getAttribute('data-row');
  var col = el.getAttribute('data-col');
  var field = el.getAttribute('data-field');
  var idx = parseInt(el.getAttribute('data-idx'));

  var ok = await saveMaintainField(sheet, row, col, field, idx, newVal);
  if (ok) {
    el.setAttribute('data-raw', newVal.replace(/"/g,'&quot;'));
    el.textContent = isDateOnlyField ? fmtDateOnly(newVal) : isDateField ? fmtDate(newVal) : newVal;
  }
}

// 原生日期選擇器（<input type="date">）的儲存邏輯：value 本身就是 yyyy-mm-dd，轉成 yyyy/mm/dd 存回試算表即可，
// 不用像 contenteditable 版本那樣處理各種手動輸入格式。
async function commitMaintainDateCell(el) {
  var newVal = el.value ? fmtDateOnly(el.value) : '';
  var original = el.dataset.original !== undefined ? el.dataset.original : fmtDateOnly(el.getAttribute('data-raw')||'');
  if (newVal === original) return;

  var sheet = el.getAttribute('data-sheet');
  var row = el.getAttribute('data-row');
  var col = el.getAttribute('data-col');
  var field = el.getAttribute('data-field');
  var idx = parseInt(el.getAttribute('data-idx'));

  var ok = await saveMaintainField(sheet, row, col, field, idx, newVal);
  if (ok) {
    el.setAttribute('data-raw', newVal.replace(/"/g,'&quot;'));
    el.dataset.original = newVal;
  }
}

async function commitMaintainSelect(selectEl) {
  var newVal = selectEl.value;
  await saveMaintainField(selectEl.getAttribute('data-sheet'), selectEl.getAttribute('data-row'), selectEl.getAttribute('data-col'), selectEl.getAttribute('data-field'), parseInt(selectEl.getAttribute('data-idx')), newVal);
}

// ---- 新增人選資料（常駐空白表單，不再跳出視窗）----
function getTodayDateStr() {
  var d = new Date();
  return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0');
}

// 複製人選資料時，這些欄位需清空（流程紀錄類欄位／104_Position 依需求不複製）；Name、履歷代碼會一起複製
var COPY_CLEAR_FIELDS = ['Phone Interview_date','Interview_date','Result','Result Update_date','Update_date','Update date','Onboard date','Memo','Phone Interview Scheduled','Interview Scheduled','Hired date'];

var selectedCandForCopy = null;

function ensureNewCandidateFieldsRendered() {
  var el = document.getElementById('newCandFields');
  if (el && !el.children.length) renderNewCandidateFields();
}

// 共用元件：給「填寫中、尚未存檔」的表單用的下拉+可手動輸入欄位（不會自動存檔，等按送出才收集）
function buildFormDatalistInput(className, field, options, prefillVal, extraAttrs) {
  var dlId = 'dl_' + (_dlIdCounter++);
  var optHtml = options.map(function(o){ return '<option value="'+String(o).replace(/"/g,'&quot;')+'">'; }).join('');
  return '<input type="text" list="'+dlId+'" class="'+className+'" data-field="'+field+'" value="'+String(prefillVal||'').replace(/"/g,'&quot;')+'" onfocus="dlInputFocus(this)" onblur="dlInputRestoreIfEmpty(this)"'+(extraAttrs||'')+' style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;">'+
    '<datalist id="'+dlId+'">'+optHtml+'</datalist>';
}

// 共用元件：給「填寫中、尚未存檔」的表單用的日期欄位——跟搜尋結果卡片的 buildDateFieldInput 一樣有月曆圖示可以點選，
// 差別是這裡選完只會更新輸入框的值（見 openMiniDatePicker 的 isDraft 參數），不會馬上存檔，等按「＋ 新增人選資料」送出時才一起收集。
function buildFormDateFieldInput(className, field, prefillVal, extraAttrs) {
  var uid = 'dtf_form_' + (_dlIdCounter++);
  var dispSafe = String(prefillVal||'').replace(/"/g,'&quot;');
  return '<div class="date-field-wrap">'+
    '<input type="text" id="'+uid+'" class="'+className+'" data-field="'+field+'" value="'+dispSafe+'" autocomplete="off"'+(extraAttrs||'')+' '+
      'style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;">'+
    '<button type="button" class="date-field-cal-btn" title="選擇日期" onmousedown="event.preventDefault()" onclick="openMiniDatePicker(document.getElementById(\''+uid+'\'), true)">📅</button>'+
  '</div>';
}

// 共用元件：給「填寫中、尚未存檔」的表單用的嚴格下拉選單（不可手動輸入），送出時才收集
function buildFormSelectInput(className, field, options, prefillVal) {
  var optHtml = '<option value=""'+(prefillVal?'':' selected')+'></option>' + options.map(function(o){
    var sel = (String(o) === String(prefillVal)) ? ' selected' : '';
    return '<option value="'+String(o).replace(/"/g,'&quot;')+'"'+sel+'>'+String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</option>';
  }).join('');
  var selectHtml = '<select class="'+className+'" data-field="'+field+'" style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;background:var(--surface);">'+optHtml+'</select>';
  if (!prefillVal) return selectHtml;
  return '<div class="select-clear-wrap">'+selectHtml+
    '<button type="button" class="select-clear-btn" title="清除" onclick="this.previousElementSibling.value=\'\'">✕</button>'+
  '</div>';
}

// 共用元件：給「填寫中、尚未存檔」的新增人選表單用的 Inviter 多選勾選框（同一格用「、」分隔，送出時才收集）
function buildFormInviterMultiSelectInput(className, field, options, prefillVal) {
  var uid = 'forminvms_' + (_dlIdCounter++);
  var selected = String(prefillVal||'').split('、').map(function(s){return s.trim();}).filter(Boolean);
  var opts = options.slice();
  selected.forEach(function(s){ if (opts.indexOf(s) < 0) opts.push(s); });
  var summary = selected.length ? selected.join('、') : '未選擇';
  var optionsHtml = opts.map(function(o){
    var checked = selected.indexOf(o) >= 0;
    var oSafe = String(o).replace(/"/g,'&quot;');
    var oDisp = String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<label class="ms-dropdown-option"><input type="checkbox" '+(checked?'checked':'')+' data-val="'+oSafe+'" onchange="toggleFormInviterMsOption(\''+uid+'\',this)"> '+oDisp+'</label>';
  }).join('');
  return '<div class="ms-dropdown" id="'+uid+'" style="width:100%;">'+
    '<button type="button" class="ms-dropdown-toggle" style="width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" onclick="toggleMsDropdownPanel(\''+uid+'\')">'+
      '<span class="invms-summary">'+summary.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span> <span class="ms-dropdown-caret">▾</span></button>'+
    '<div class="ms-dropdown-panel" id="'+uid+'-panel" style="display:none;">'+
      optionsHtml+
      '<div class="invms-add-row">'+
        '<input type="text" id="'+uid+'-newname" placeholder="新增其他選項..." onkeydown="if(event.key===\'Enter\'){event.preventDefault();addFormInviterMsName(\''+uid+'\')}">'+
        '<button type="button" onclick="addFormInviterMsName(\''+uid+'\')">新增</button>'+
      '</div>'+
      '<div class="invms-clear-row"><span class="date-filter-clear" onclick="clearFormInviterMsSelection(\''+uid+'\')">清除已勾選</span></div>'+
    '</div>'+
    '<input type="hidden" class="'+className+'" data-field="'+field+'" value="'+String(prefillVal||'').replace(/"/g,'&quot;')+'">'+
  '</div>';
}
function clearFormInviterMsSelection(uid) {
  var container = document.getElementById(uid);
  if (!container) return;
  container.querySelectorAll('input[type=checkbox]').forEach(function(cb){ cb.checked = false; });
  var hidden = container.querySelector('input[type=hidden]');
  hidden.value = '';
  var summaryEl = container.querySelector('.invms-summary');
  if (summaryEl) summaryEl.textContent = '未選擇';
  runFormAutoSyncIfNeeded(hidden);
}
// 只有 Inviter／104_Position 這兩個欄位改動時才需要觸發「自動帶入單位／Job Function」，
// 其他欄位（單位、Job Function、負責HR、面試主管）改成多選勾選後，不應該誤觸這兩個自動帶入邏輯；
// 但「單位」改動時，需要重新整理 Inviter 的選項，讓 Inviter 只顯示這個單位底下的人。
function runFormAutoSyncIfNeeded(hidden) {
  var field = hidden.getAttribute('data-field');
  if (field === 'Inviter') handleInviterInputChange(hidden);
  if (field === '104_Position') handlePositionInputChange(hidden);
  if (field === '單位') refreshNewCandInviterOptions();
}

// 「單位」改變時（勾選／新增／清除），依 Manager Information 重新篩出這個單位的 Inviter 名單，
// 並重建 Inviter 的勾選下拉元件（保留使用者已勾選的名字，即使不在篩選後的名單裡也不會消失）
function refreshNewCandInviterOptions() {
  var invHidden = document.querySelector(getNewCandFormSelector() + '[data-field="Inviter"]');
  if (!invHidden) return;
  var wrapper = invHidden.closest('.ms-dropdown');
  if (!wrapper) return;
  var buHidden = document.querySelector(getNewCandFormSelector() + '[data-field="單位"]');
  var unitVal = buHidden ? buHidden.value : '';
  var options = MAINTAIN_DROPDOWNS['Candidate Records']['Inviter'](unitVal);
  wrapper.outerHTML = buildFormInviterMultiSelectInput('new-cand-input', 'Inviter', options, invHidden.value);
}
function toggleFormInviterMsOption(uid, checkboxEl) {
  var container = document.getElementById(uid);
  var hidden = container.querySelector('input[type=hidden]');
  var current = hidden.value.split('、').map(function(s){return s.trim();}).filter(Boolean);
  var val = checkboxEl.getAttribute('data-val');
  var i = current.indexOf(val);
  if (checkboxEl.checked) { if (i < 0) current.push(val); } else if (i >= 0) { current.splice(i,1); }
  hidden.value = current.join('、');
  container.querySelector('.invms-summary').textContent = hidden.value || '未選擇';
  runFormAutoSyncIfNeeded(hidden);
}
function addFormInviterMsName(uid) {
  var container = document.getElementById(uid);
  var input = document.getElementById(uid+'-newname');
  var name = input.value.trim();
  if (!name) return;
  var hidden = container.querySelector('input[type=hidden]');
  var current = hidden.value.split('、').map(function(s){return s.trim();}).filter(Boolean);
  if (current.indexOf(name) < 0) current.push(name);
  hidden.value = current.join('、');
  input.value = '';
  container.querySelector('.invms-summary').textContent = hidden.value || '未選擇';
  var panel = document.getElementById(uid+'-panel');
  var label = document.createElement('label');
  label.className = 'ms-dropdown-option';
  var nameSafe = name.replace(/"/g,'&quot;');
  var nameDisp = name.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  label.innerHTML = '<input type="checkbox" checked data-val="'+nameSafe+'" onchange="toggleFormInviterMsOption(\''+uid+'\',this)"> '+nameDisp;
  panel.insertBefore(label, panel.querySelector('.invms-add-row'));
  runFormAutoSyncIfNeeded(hidden);
}

// 判斷是否為「電訪紀錄(HR)／(主管)」欄位——跟 buildCandQueryCardsHtml 共用同一套判斷規則，
// 兩個表單的排版才會完全一致（並排顯示、HR 固定在左、主管固定在右）
function isPhoneRecordFieldName(h) {
  return /phone\s*interview\s*record/i.test(h);
}

// 邀約日欄位離開時自動整理成 YYYY/MM/DD（例如手動輸入 6/25、貼上其他格式，甚至不小心貼到瀏覽器原生
// Date 字串如 "Thu Jun 25 2026 00:00:00 GMT+0800"，都會在離開欄位時被 fmtDateOnly 轉回統一格式）
function normalizeNewCandDateField(el) {
  if (!el.value.trim()) return;
  el.value = fmtDateOnly(el.value);
}

function renderNewCandidateFields() {
  // 排版要跟「搜尋結果」卡片一致：套用同一個角色欄位過濾（filterCandHeadersForRole，例如 BP 看不到的欄位），
  // 而不是只排除 MAINTAIN_QUERY_HIDDEN_FIELDS
  var headers = filterCandHeadersForMaintenance(maintainHeaders['Candidate Records'] || ['invite_date','單位','Job Function','104_Position','Name','性別','年齡','最高學歷','學校','科系','履歷代碼','Source','Inviter','Phone Interview_date','Interview_date','Result','Result Update_date','Onboard date','負責HR','Memo']);
  var dropdowns = MAINTAIN_DROPDOWNS['Candidate Records'] || {};
  var requiredFields = ['Name','Result','invite_date'];
  var todayStr = getTodayDateStr();

  // 電訪紀錄(HR)／(主管) 欄位並排顯示邏輯，跟 buildCandQueryCardsHtml 完全比照
  var phoneRecordFields = headers.filter(isPhoneRecordFieldName).sort(function(a,b){
    return (/hr/i.test(a)?0:1) - (/hr/i.test(b)?0:1); // HR 固定在左，主管固定在右
  });
  var pairedPhoneRecordDone = false;

  function buildOneField(h, isPaired) {
    var isRequired = requiredFields.indexOf(h) >= 0;
    var label = h + (isRequired ? ' <span style="color:#EF4444;">*</span>' : '');
    var isInviteDate = (h === 'invite_date' || h === 'invite date');
    var isMemo = h.indexOf('Memo') >= 0;
    var isPhoneRecord = isPhoneRecordFieldName(h);
    var isMultilineField = isMemo || isPhoneRecord;
    var isHRComment = /^hr\s*comment$/i.test(h.trim());
    var isDateField = MAINTAIN_DATE_FIELDS.indexOf(h) >= 0;
    var isPosition = h === '104_Position';
    var isNameOrResume = (h === 'Name' || h.indexOf('履歷代碼') >= 0);
    // 並排的電訪紀錄欄位不要再各自佔滿整排（外層已經是整排的兩欄容器了）
    var spanStyle = isPaired ? '' : ((isMultilineField || isHRComment) ? 'grid-column:1/-1;' : (isPosition ? 'grid-column:span 2;' : ''));
    var dupAttr = isNameOrResume ? ' oninput="checkNewCandDuplicate()"' : '';
    // 負責HR：自動帶入這台瀏覽器最近一次填寫過的名字，同一位 HR 不用每次重打
    // 邀約日：一律用 fmtDateOnly 正規化成 YYYY/MM/DD（避免不小心存到／貼到瀏覽器原生 Date 字串格式，例如 "Thu Jun 25 2026 00:00:00 GMT+0800"）
    var prefillVal = isInviteDate ? fmtDateOnly(todayStr) : (h === '負責HR' ? getLastUsedHR() : '');

    // Inviter 有填寫時，依 Manager Information 工作表的姓名比對自動帶入 單位
    var inviterAttr = (h === 'Inviter') ? ' oninput="handleInviterInputChange(this)" onchange="handleInviterInputChange(this)"' : '';
    // 104_Position 有填寫時，自動擷取【】內文字帶入 Job Function
    var positionAttr = isPosition ? ' oninput="handlePositionInputChange(this)" onchange="handlePositionInputChange(this)"' : '';
    // 邀約日：手動輸入或不小心貼上其他格式時，離開欄位就自動改回 YYYY/MM/DD；並關閉瀏覽器自動填字建議，避免帶入奇怪格式
    var inviteDateAttr = isInviteDate ? ' onblur="normalizeNewCandDateField(this)" autocomplete="off"' : '';
    var extraAttr = inviterAttr + positionAttr + inviteDateAttr;

    var fieldHtml;
    if (dropdowns[h]) {
      var options = dropdowns[h]();
      var inputHtml = (MULTI_SELECT_FIELDS.indexOf(h) >= 0)
        ? buildFormInviterMultiSelectInput('new-cand-input', h, options, prefillVal)
        : (STRICT_SELECT_FIELDS.indexOf(h) >= 0)
        ? buildFormSelectInput('new-cand-input', h, options, prefillVal)
        : buildFormDatalistInput('new-cand-input', h, options, prefillVal, extraAttr);
      fieldHtml = '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+inputHtml+'</div>';
    } else if (isMultilineField) {
      // Memo：像 Excel 儲存格一樣，Enter 直接換下一行，且高度依內容自動變長。
      // Phone Interview Record(HR)／(主管)：不跟著內容自動長高，但也不固定死高度，使用者可以自己拖拉調整要多高。
      var escapedVal = String(prefillVal||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      fieldHtml = '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+
        '<textarea class="new-cand-input'+(isPhoneRecord?' ta-scrollable':'')+'" data-field="'+h+'" rows="2" '+(isPhoneRecord?'':'oninput="autoGrowTextarea(this)" ')+
        'style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;font-family:inherit;resize:vertical;'+
        (isPhoneRecord ? 'min-height:70px;' : 'min-height:38px;overflow:hidden;')+'">'+escapedVal+'</textarea></div>';
    } else if (isDateField) {
      // 日期欄位跟搜尋結果卡片一樣有月曆圖示可以點選（見 buildFormDateFieldInput），選完只更新這裡的顯示值，
      // 送出「＋ 新增人選資料」時才會一起存檔；還是可以手動打字，邀約日離開欄位時一樣會自動整理成 YYYY/MM/DD。
      fieldHtml = '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+buildFormDateFieldInput('new-cand-input', h, prefillVal, extraAttr)+'</div>';
    } else {
      fieldHtml = '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" class="new-cand-input" data-field="'+h+'" value="'+prefillVal+'"'+dupAttr+extraAttr+' style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"></div>';
    }
    // Memo 欄位下方加一條分隔線，把表單分成前後兩區
    if (isMemo) fieldHtml += '<div style="grid-column:1/-1;border-top:1px solid var(--border);margin:6px 0 2px;"></div>';
    return fieldHtml;
  }

  document.getElementById('newCandFields').innerHTML = headers.map(function(h){
    if (isPhoneRecordFieldName(h)) {
      if (pairedPhoneRecordDone) return ''; // 另一個欄位已經跟第一個並排畫在同一排了
      pairedPhoneRecordDone = true;
      if (phoneRecordFields.length >= 2) {
        var pairHtml = phoneRecordFields.map(function(pf){ return buildOneField(pf, true); }).join('');
        return '<div style="grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:14px;">'+pairHtml+'</div>';
      }
      return buildOneField(h, false);
    }
    return buildOneField(h, false);
  }).join('');

  document.getElementById('newCandFields').querySelectorAll('textarea.new-cand-input:not(.ta-scrollable)').forEach(autoGrowTextarea);
  document.getElementById('newCandDupWarning').style.display = 'none';
}

// 依內容自動調整 textarea 高度（先歸零再抓 scrollHeight，避免內容變短時高度卡住不縮回去）
function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Manager Information 比對：Inviter 欄位有值時，自動把對應的「單位」帶入同一張表單的 單位 欄位
// Inviter 可能是多人（用「、」分隔），以第一位為準
function handleInviterInputChange(el) {
  var firstName = String(el.value||'').split('、')[0].trim();
  var bu = findBUByInviterName(firstName);
  if (!bu) return;
  var container = el.closest('#newCandFields') || el.closest('#addRowModalFields');
  if (!container) return;
  var buInput = container.querySelector('[data-field="單位"]');
  if (buInput) applyFieldDisplayValue(buInput, bu);
}

// 104_Position 欄位有值時，自動擷取【】內的文字帶入同一張表單的 Job Function 欄位
function extractJobFunctionFromPosition(positionVal) {
  var m = String(positionVal||'').match(/【([^】]+)】/);
  return m ? m[1].trim() : '';
}
function handlePositionInputChange(el) {
  var jf = extractJobFunctionFromPosition(el.value);
  if (!jf) return;
  var container = el.closest('#newCandFields') || el.closest('#addRowModalFields');
  if (!container) return;
  var jfInput = container.querySelector('[data-field="Job Function"]');
  if (jfInput) applyFieldDisplayValue(jfInput, jf);
}

// 新增人選表單的欄位 selector（資料維護畫面的常駐新增表單）
function getNewCandFormSelector() {
  return '#newCandFields .new-cand-input';
}

// ---- 搜尋全部人選（跨單位）----
// 查詢範圍是 allDataFull（完整、未依單位過濾的名單），不受目前身分的單位權限限制，
// 用來確認其他單位／其他 HR 是否已經約過某個人，避免重複邀約。
// 顯示位置：直接顯示在搜尋框下方（不跳出視窗），欄位排版跟編輯功能都與下方「本單位搜尋結果」完全一致，
// 可以直接編輯這些其他單位的資料（例如補寫電訪紀錄、更新 Result 等）；
// 唯獨不提供「刪除」功能，避免不小心刪掉其他單位的資料，只保留「選取以複製」。
var searchAllCandidatesOpen = false;

function toggleSearchAllCandidates() {
  searchAllCandidatesOpen = !searchAllCandidatesOpen;
  var btn = document.getElementById('searchAllCandidatesBtn');
  if (btn) btn.textContent = searchAllCandidatesOpen ? '✕ 關閉全部單位搜尋結果' : '🔍 搜尋全部人選（含其他單位）';
  renderSearchAllCandidatesResults();
}

function renderSearchAllCandidatesResults() {
  var container = document.getElementById('searchAllCandidatesResults');
  if (!container) return;
  if (!searchAllCandidatesOpen) { container.innerHTML = ''; return; }

  var searchInput = document.getElementById('candQuerySearch');
  var search = (searchInput ? searchInput.value : '').trim().toLowerCase();
  var terms = splitSearchTerms(search);
  if (!terms.length) {
    container.innerHTML = '<div class="empty" style="padding:16px 0;text-align:center;">請在上方輸入姓名或履歷代碼，查詢是否有其他單位約過這位人選</div>';
    return;
  }

  // 本單位（allData）已經在下方顯示過的紀錄，這裡不重複列出，只顯示「其他單位」才有的紀錄
  var scopedRows = {};
  allData.forEach(function(d){ scopedRows[d._row] = true; });
  var matched = allDataFull.filter(function(d){
    if (scopedRows[d._row]) return false;
    var resumeKey = findResumeCodeKey(d);
    return matchesAnySearchTerm(d.Name, terms) || matchesAnySearchTerm(d[resumeKey], terms);
  });

  var header = '<div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin:6px 0 8px;">🔍 其他單位搜尋結果'+(matched.length?'（共 '+matched.length+' 筆，可直接編輯／複製）':'')+'</div>';
  if (!matched.length) {
    container.innerHTML = header + '<div class="empty" style="padding:16px 0;text-align:center;">其他單位沒有符合的人選</div>';
    return;
  }
  container.innerHTML = header + buildCrossUnitCandCardsHtml(matched);
  container.querySelectorAll('textarea:not(.ta-scrollable)').forEach(autoGrowTextarea);
}

// 輸入姓名或履歷代碼時，即時檢查這位人選是否已經有紀錄，避免重複建檔。
// 注意：這裡故意查「allDataFull」（完整、未依單位過濾的名單），而不是畫面上其他地方用的 allData，
// 這樣即使這位人選是其他單位／其他 HR 已經約過的，也能在這裡看得到、避免不同 HR 重複邀約同一人。
function checkNewCandDuplicate() {
  var name = '', resume = '';
  document.querySelectorAll(getNewCandFormSelector()).forEach(function(inp){
    var f = inp.getAttribute('data-field');
    if (f === 'Name') name = inp.value.trim().toLowerCase();
    if (f && f.indexOf('履歷代碼') >= 0) resume = inp.value.trim().toLowerCase();
  });
  var warnEl = document.getElementById('newCandDupWarning');
  if (!warnEl) return;
  if (!name && !resume) { warnEl.style.display = 'none'; return; }

  var matched = allDataFull.filter(function(d){
    var resumeKey = findResumeCodeKey(d);
    return (name && String(d.Name||'').toLowerCase()===name) || (resume && String(d[resumeKey]||'').toLowerCase()===resume);
  });
  if (matched.length) {
    warnEl.style.display = '';
    // 同一個人可能有多筆歷史紀錄（例如應徵過不同單位／職缺），每一筆都要各自列出來，不要只顯示一筆
    var rowsHtml = matched.map(function(m){
      return '<div style="padding:4px 0;border-top:1px dashed rgba(146,64,14,.25);">'+
        '<b>'+(m.Name||'')+'</b>（'+(m['履歷代碼']||'—')+'）'+
        ' · 單位：'+(m['單位']||'—')+
        ' · Job Function：'+(m['Job Function']||'—')+
        ' · 負責HR：'+(m['負責HR']||'—')+
        ' · 邀約日：'+(m.invite_date||'—')+
        ' · 目前狀態：'+(m.Result||'—')+
      '</div>';
    }).join('');
    warnEl.innerHTML = '⚠️ 已經有 '+matched.length+' 筆相符的紀錄，請確認是否要繼續新增，避免重複建檔／重複邀約：' + rowsHtml;
  } else {
    warnEl.style.display = 'none';
  }
}

// 點選人選資料卡，標記為「要複製的來源」
// 注意：這裡故意查「allDataFull」而不是 allData——搜尋全部人選（跨單位）顯示的紀錄本來就不在
// 目前身分的 allData 範圍內，若只查 allData 會導致跨單位那筆資料選取以複製時失敗。
function selectCandForCopy(row) {
  var cand = allDataFull.find(function(d){ return d._row === row; });
  if (!cand) return;
  selectedCandForCopy = cand;
  renderNewCandSelectedHint();
  if (currentTab === 'maintain') renderCandQuery();
}

// 取消選取：只清掉「要複製的來源」，不會動到新增表單目前已經填的內容
function clearCandForCopy() {
  selectedCandForCopy = null;
  renderNewCandSelectedHint();
  if (currentTab === 'maintain') renderCandQuery();
}

function renderNewCandSelectedHint() {
  var hintEl1 = document.getElementById('newCandSelectedHint');
  if (!hintEl1) return;
  hintEl1.innerHTML = selectedCandForCopy
    ? '已選取「'+(selectedCandForCopy.Name||'')+'」，可用「複製人選資料」套用到新增表單　<span style="cursor:pointer;text-decoration:underline;color:var(--accent);" onclick="clearCandForCopy()">取消選取</span>'
    : '';
}

// 把選取的人選資料套用到新增表單（Name、履歷代碼會一起複製；104_Position 與流程紀錄類欄位不複製）
function applyCopyToNewCandidateForm() {
  if (!selectedCandForCopy) { showToast('請先在下方人選清單點選要複製的人選'); return; }
  var todayStr = getTodayDateStr();
  document.querySelectorAll(getNewCandFormSelector()).forEach(function(inp){
    var f = inp.getAttribute('data-field');
    var isInviteDate = (f === 'invite_date' || f === 'invite date');
    var isPosition = f.indexOf('104') >= 0;
    if (isInviteDate) { applyFieldDisplayValue(inp, todayStr); return; }
    if (isPosition || COPY_CLEAR_FIELDS.indexOf(f) >= 0) { applyFieldDisplayValue(inp, ''); return; }
    applyFieldDisplayValue(inp, selectedCandForCopy[f] || '');
    if (inp.tagName === 'TEXTAREA' && !inp.classList.contains('ta-scrollable')) autoGrowTextarea(inp);
  });
  refreshNewCandInviterOptions(); // 複製過來的單位可能跟原本不同，重新篩一次 Inviter 選項
  showToast('✓ 已複製「'+(selectedCandForCopy.Name||'')+'」的資料，可修改後再新增');
  checkNewCandDuplicate();
}

function clearNewCandidateForm() {
  selectedCandForCopy = null;
  renderNewCandSelectedHint();
  renderNewCandidateFields();
  renderCandQuery();
}

async function submitNewCandidateForm() {
  var requiredFields = ['Name','Result','invite_date'];
  var headers = maintainHeaders['Candidate Records'] || [];
  var values = {};
  var missing = [];
  document.querySelectorAll('#newCandFields .new-cand-input').forEach(function(inp){
    var field = inp.getAttribute('data-field');
    var val = inp.value.trim();
    if (val && (MAINTAIN_DATE_FIELDS.indexOf(field) >= 0 || MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0)) {
      val = normalizeDateForSave(field, val);
    }
    values[field] = val;
    if (requiredFields.indexOf(field) >= 0 && !val) missing.push(field);
  });
  if (missing.length) { showToast('請填寫必填欄位：'+missing.join('、')); return; }

  saveLastUsedHR(values['負責HR']);
  var orderedValues = headers.map(function(h){ return values[h] || ''; });
  showToast('新增中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('Candidate Records') +
      '&values=' + encodeURIComponent(JSON.stringify(orderedValues));
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    selectedCandForCopy = null;
    renderNewCandSelectedHint();
    renderNewCandidateFields();
    renderCandQuery();
    showToast('✓ 已新增人選資料');
  } catch(e) {
    showToast('❌ 新增失敗：'+e.message);
  }
}

function addMaintainRow() {
  var records = getMaintainRecords(maintainSheet);
  var headers = maintainHeaders[maintainSheet] || (records.length ? Object.keys(records[0]).filter(function(k){return k!=='_row';}) : []);
  if (!headers.length) { showToast('找不到欄位資訊，無法新增'); return; }

  document.getElementById('addRowModalSub').textContent = '新增至「'+maintainSheet+'」，填寫後會直接寫入試算表';
  var requiredFields = maintainSheet === 'Headcount Records' ? ['Division'] : maintainSheet === 'Market Salary Records' ? ['Company'] : ['Name','Result'];
  var dropdowns = MAINTAIN_DROPDOWNS[maintainSheet] || {};

  document.getElementById('addRowModalFields').innerHTML = headers.map(function(h){
    var isRequired = requiredFields.indexOf(h) >= 0;
    var label = h + (isRequired ? ' <span style="color:#EF4444;">*</span>' : '');
    if (dropdowns[h]) {
      var options = dropdowns[h]();
      return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+buildFormDatalistInput('add-row-input', h, options, '')+'</div>';
    }
    return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" data-field="'+h+'" class="add-row-input" style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"></div>';
  }).join('');

  document.querySelector('#addRowModal .modal').classList.remove('modal-wide');
  document.getElementById('addRowModalFields').classList.remove('cand-new-fields-grid');
  document.getElementById('addRowModal').style.display = 'flex';
}

// Headcount Overview 各單位區塊表格的刪除按鈕：直接刪除 Headcount Records 裡的這一列
// 明確指定 sheet 為 'Headcount Records'（不能沿用 maintainSheet，因為使用者可能同時停留在其他分頁，maintainSheet 未必是 Headcount Records）
async function deleteHeadcountRow(row) {
  if (!confirm('確定要刪除這筆 Headcount 資料嗎？此動作無法復原。')) return;
  showToast('刪除中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=deleteRow&sheet=' + encodeURIComponent('Headcount Records') + '&row=' + encodeURIComponent(row);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    hcRawData = hcRawData.filter(function(r){ return String(r._row) !== String(row); });
    renderHeadcount();
    await fetchData();
    renderHeadcount();
    showToast('✓ 已刪除');
  } catch(e) {
    showToast('❌ 刪除失敗：'+e.message);
  }
}

// Headcount Overview 各單位區塊的「＋ 新增 Headcount」：重用共用的 addRowModal，直接寫入 Headcount Records
function openHcNewRowModal(divisionName) {
  var headers = maintainHeaders['Headcount Records'] || [];
  if (!headers.length) { showToast('找不到 Headcount Records 欄位資訊'); return; }
  var dropdowns = MAINTAIN_DROPDOWNS['Headcount Records'] || {};
  var divisionKey = headers.find(function(h){return h.trim()==='Division';}) || 'Division';

  document.getElementById('addRowModalSub').textContent = '新增一筆 Headcount 至「'+divisionName+'」';
  document.getElementById('addRowModalFields').innerHTML = headers.map(function(h){
    var isDivision = h === divisionKey;
    var isRequired = isDivision;
    var label = h + (isRequired ? ' <span style="color:#EF4444;">*</span>' : '');
    var prefillVal = isDivision ? divisionName : '';

    if (dropdowns[h]) {
      var options = dropdowns[h]();
      return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+buildFormDatalistInput('hc-new-row-input', h, options, prefillVal)+'</div>';
    }
    if (MAINTAIN_DATEONLY_FIELDS.indexOf(h) >= 0) {
      // Requisition Date 等日期欄位改用原生月曆選擇器，跟 Headcount Overview 表格內的編輯體驗一致
      return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="date" data-field="'+h+'" class="hc-new-row-input" style="width:100%;font-size:13px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"></div>';
    }
    var valAttr = prefillVal ? ' value="'+String(prefillVal).replace(/"/g,'&quot;')+'"' : '';
    return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" data-field="'+h+'" class="hc-new-row-input" style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"'+valAttr+'></div>';
  }).join('');

  document.querySelector('#addRowModal .modal').classList.add('modal-wide');
  document.getElementById('addRowModalFields').classList.remove('cand-new-fields-grid');
  document.getElementById('addRowModal').style.display = 'flex';
  window._hcNewRowMode = true;
}

async function submitHcNewRow() {
  var headers = maintainHeaders['Headcount Records'] || [];
  var divisionKey = headers.find(function(h){return h.trim()==='Division';}) || 'Division';
  var requiredFields = [divisionKey];
  var values = {};
  var missing = [];
  document.querySelectorAll('#addRowModalFields .hc-new-row-input').forEach(function(inp){
    var field = inp.getAttribute('data-field');
    var val = inp.value.trim();
    if (val && (MAINTAIN_DATE_FIELDS.indexOf(field) >= 0 || MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0)) {
      val = normalizeDateForSave(field, val);
    }
    values[field] = val;
    if (requiredFields.indexOf(field) >= 0 && !val) missing.push(field);
  });
  if (missing.length) { showToast('請填寫必填欄位：'+missing.join('、')); return; }

  var orderedValues = headers.map(function(h){ return values[h] || ''; });
  window._hcNewRowMode = false;
  closeAddRowModal();
  showToast('新增中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('Headcount Records') +
      '&values=' + encodeURIComponent(JSON.stringify(orderedValues));
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'hc') renderHeadcount();
    showToast('✓ 已新增 Headcount 資料');
  } catch(e) {
    showToast('❌ 新增失敗：'+e.message);
  }
}

function closeAddRowModal() {
  document.getElementById('addRowModal').style.display = 'none';
  document.querySelector('#addRowModal .modal').classList.remove('modal-wide');
  window._hcNewRowMode = false;
}

function handleAddRowModalSubmit() {
  if (window._hcNewRowMode) submitHcNewRow();
  else submitAddRow();
}

async function submitAddRow() {
  var targetSheet = maintainSheet;
  var headers = maintainHeaders[targetSheet] || [];
  var requiredFields = targetSheet === 'Headcount Records' ? ['Division'] : targetSheet === 'Market Salary Records' ? ['Company'] : ['Name','Result'];

  var values = {};
  var missing = [];
  document.querySelectorAll('#addRowModalFields .add-row-input').forEach(function(inp){
    var field = inp.getAttribute('data-field');
    var val = inp.value.trim();
    if (val && (MAINTAIN_DATE_FIELDS.indexOf(field) >= 0 || MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0)) {
      val = normalizeDateForSave(field, val);
    }
    values[field] = val;
    if (requiredFields.indexOf(field) >= 0 && !val) missing.push(field);
  });

  if (missing.length) {
    showToast('請填寫必填欄位：'+missing.join('、'));
    return;
  }

  var orderedValues = headers.map(function(h){ return values[h] || ''; });
  closeAddRowModal();
  var statusEl = document.getElementById('maintainStatus');
  if (statusEl) statusEl.textContent = '新增中...';
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent(targetSheet) +
      '&values=' + encodeURIComponent(JSON.stringify(orderedValues));
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    if (statusEl) statusEl.textContent = '正在同步...';
    await fetchData();
    if (currentTab === 'maintain') renderMaintain();
    if (statusEl) { statusEl.textContent = '✓ 已新增一列'; setTimeout(function(){statusEl.textContent='';}, 2000); }
  } catch(e) {
    if (statusEl) statusEl.textContent = '❌ 新增失敗：'+e.message;
    showToast('❌ 新增失敗：'+e.message);
  }
}

async function deleteMaintainRow(row) {
  if (!confirm('確定要刪除這一列嗎？此動作無法復原。')) return;
  var statusEl = document.getElementById('maintainStatus');
  if (statusEl) statusEl.textContent = '刪除中...';
  showToast('刪除中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=deleteRow&sheet=' + encodeURIComponent(maintainSheet) + '&row=' + encodeURIComponent(row);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'maintain') { if (maintainSheet==='Candidate Records') renderCandQuery(); else renderMaintain(); }
    if (statusEl) { statusEl.textContent = '✓ 已刪除'; setTimeout(function(){statusEl.textContent='';}, 2000); }
    showToast('✓ 已刪除');
  } catch(e) {
    if (statusEl) statusEl.textContent = '❌ 刪除失敗：'+e.message;
    showToast('❌ 刪除失敗：'+e.message);
  }
}

// ===== 面試時間協調 =====
function openScheduleModal() {
  document.getElementById('schedCandSearch').value = '';
  document.getElementById('schedRound').value = '電訪';
  populateManagerBUOptions();
  resetManagerSelects();
  scheduleManagerList = [];
  renderManagerTags();
  populateCreatorDatalist();
  // 帶入上一次建立邀約的人，避免同一人連續建立多筆時要重複輸入；如果這次是別人建立，直接改掉即可
  var lastCreator = getLastCreator();
  document.getElementById('schedCreatorName').value = lastCreator ? lastCreator.name : '';
  document.getElementById('schedCreatorEmail').value = lastCreator ? lastCreator.email : '';
  document.getElementById('scheduleModal').style.display = 'flex';
}

function closeScheduleModal() {
  document.getElementById('scheduleModal').style.display = 'none';
}

// ---- 邀請多位主管：加入清單後一次寄信 ----
var scheduleManagerList = [];

function renderManagerTags() {
  var wrap = document.getElementById('schedManagerTags');
  if (!wrap) return;
  if (!scheduleManagerList.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = scheduleManagerList.map(function(m, idx){
    return '<span style="display:inline-flex;align-items:center;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:4px 6px 4px 12px;font-size:12px;">'+
      (m.name||'（未命名）')+'（'+(m.email||'')+'）'+
      '<button onclick="removeManagerFromScheduleList('+idx+')" style="border:none;background:none;cursor:pointer;color:var(--text-tertiary);font-size:14px;line-height:1;padding:2px;">✕</button>'+
    '</span>';
  }).join('');
}

function addManagerToScheduleList() {
  var info = getSelectedManagerInfo();
  if (!info.name) { showToast('請選擇或輸入主管姓名'); return; }
  if (!info.email) { showToast('請選擇或輸入主管 Email'); return; }
  if (scheduleManagerList.some(function(m){ return m.email.toLowerCase() === info.email.toLowerCase(); })) {
    showToast('這位主管已經在清單裡了');
    return;
  }
  scheduleManagerList.push({ name: info.name, email: info.email });
  renderManagerTags();
  // 清空目前的選擇，方便繼續加入下一位主管
  resetManagerSelects();
}

function removeManagerFromScheduleList(idx) {
  scheduleManagerList.splice(idx, 1);
  renderManagerTags();
}

// ---- 主管名冊：BU → 主管 → Email（資料來源：Manager Email 工作表）----
function populateManagerBUOptions() {
  var sel = document.getElementById('schedManagerBU');
  if (!sel) return;
  var bus = [...new Set(managerDirectoryData.map(function(m){return String(m.BU||'').trim();}))].filter(Boolean).sort();
  sel.innerHTML = '<option value="">請選擇單位...</option>' +
    bus.map(function(b){return '<option value="'+b.replace(/"/g,'&quot;')+'">'+b+'</option>';}).join('') +
    '<option value="__other__">其他（不在名冊中，手動輸入）</option>';
}

function resetManagerSelects() {
  document.getElementById('schedManagerBU').value = '';
  document.getElementById('schedManagerSelect').innerHTML = '<option value="">請先選擇單位...</option>';
  document.getElementById('schedManagerNameManual').value = '';
  document.getElementById('schedManagerManualWrap').style.display = 'none';
  document.getElementById('schedManagerEmail').value = '';
}

function onSchedManagerBUChange() {
  var bu = document.getElementById('schedManagerBU').value;
  var sel = document.getElementById('schedManagerSelect');
  var manualWrap = document.getElementById('schedManagerManualWrap');
  var emailEl = document.getElementById('schedManagerEmail');
  document.getElementById('schedManagerNameManual').value = '';
  emailEl.value = '';

  if (!bu) {
    sel.innerHTML = '<option value="">請先選擇單位...</option>';
    sel._managers = [];
    manualWrap.style.display = 'none';
    return;
  }
  if (bu === '__other__') {
    sel.innerHTML = '<option value="__other__">（不在名冊中，請於下方手動輸入）</option>';
    sel.value = '__other__';
    sel._managers = [];
    manualWrap.style.display = '';
    return;
  }
  var managers = managerDirectoryData.filter(function(m){ return String(m.BU||'').trim() === bu; });
  sel.innerHTML = '<option value="">請選擇主管...</option>' +
    managers.map(function(m, idx){ return '<option value="'+idx+'">'+m.Name+'</option>'; }).join('') +
    '<option value="__other__">其他（不在名冊中，手動輸入）</option>';
  sel._managers = managers;
  manualWrap.style.display = 'none';
}

function onSchedManagerSelectChange() {
  var sel = document.getElementById('schedManagerSelect');
  var val = sel.value;
  var manualWrap = document.getElementById('schedManagerManualWrap');
  var emailEl = document.getElementById('schedManagerEmail');

  if (val === '__other__') {
    manualWrap.style.display = '';
    emailEl.value = '';
    return;
  }
  manualWrap.style.display = 'none';
  var managers = sel._managers || [];
  var idx = parseInt(val);
  emailEl.value = (!isNaN(idx) && managers[idx]) ? (managers[idx].Email || '') : '';
}

function getSelectedManagerInfo() {
  var buSel = document.getElementById('schedManagerBU');
  var mgrSel = document.getElementById('schedManagerSelect');
  var emailEl = document.getElementById('schedManagerEmail');
  var manualNameEl = document.getElementById('schedManagerNameManual');
  var bu = buSel.value;

  if (bu === '__other__' || mgrSel.value === '__other__') {
    return {
      bu: bu === '__other__' ? '' : bu,
      name: (manualNameEl.value||'').trim(),
      email: (emailEl.value||'').trim()
    };
  }
  var managers = mgrSel._managers || [];
  var idx = parseInt(mgrSel.value);
  var m = (!isNaN(idx) && managers[idx]) ? managers[idx] : null;
  return { bu: bu, name: m ? m.Name : '', email: m ? m.Email : '' };
}

// ---- 建立人（你）：沿用歷史紀錄自動記住 Email ----
function buildNameEmailDirectory_(nameKey, emailKey) {
  var map = {};
  scheduleData.forEach(function(r){
    var nm = String(r[nameKey]||'').trim();
    var em = String(r[emailKey]||'').trim();
    if (!nm || !em) return;
    map[nm] = em;
  });
  return map;
}

function getCreatorDirectory() { return buildNameEmailDirectory_('CreatedByName','CreatedByEmail'); }

function getLastCreator() {
  for (var i = scheduleData.length - 1; i >= 0; i--) {
    var r = scheduleData[i];
    if (r.CreatedByName && r.CreatedByEmail) return {name: r.CreatedByName, email: r.CreatedByEmail};
  }
  return null;
}

function populateCreatorDatalist() {
  var list = document.getElementById('schedCreatorNameList');
  if (!list) return;
  var names = Object.keys(getCreatorDirectory()).sort();
  list.innerHTML = names.map(function(n){ return '<option value="'+n.replace(/"/g,'&quot;')+'">'; }).join('');
}

function autofillCreatorEmail() {
  var nameEl = document.getElementById('schedCreatorName');
  var emailEl = document.getElementById('schedCreatorEmail');
  if (!nameEl || !emailEl) return;
  var name = (nameEl.value||'').trim();
  var dir = getCreatorDirectory();
  if (name && dir[name]) {
    emailEl.value = dir[name];
  }
}

async function submitCreateSchedule() {
  var search = (document.getElementById('schedCandSearch').value||'').trim().toLowerCase();
  // 如果使用者填了主管欄位但忘記按「＋加入」，先幫忙加入一次，避免白填
  if (!scheduleManagerList.length) {
    var current = getSelectedManagerInfo();
    if (current.name && current.email) scheduleManagerList.push({name: current.name, email: current.email});
  }
  var creatorEmail = (document.getElementById('schedCreatorEmail').value||'').trim();
  var creatorName = (document.getElementById('schedCreatorName').value||'').trim();
  if (!search) { showToast('請輸入人選姓名或履歷代碼'); return; }
  if (!creatorEmail) { showToast('請輸入你的 Email，主管回信時才會寄到你的信箱'); return; }
  if (!scheduleManagerList.length) { showToast('請至少加入一位主管'); return; }
  var matched = allData.filter(function(d){
    var resumeKey = findResumeCodeKey(d);
    return String(d.Name||'').toLowerCase().includes(search) || String(d[resumeKey]||'').toLowerCase().includes(search);
  });
  if (!matched.length) { showToast('找不到符合的人選'); return; }
  if (matched.length > 1) { showToast('找到 '+matched.length+' 筆符合的人選，請輸入更精確的姓名或履歷代碼'); return; }
  var cand = matched[0];
  var resumeKey2 = findResumeCodeKey(cand);
  var managersToSend = scheduleManagerList.slice();
  closeScheduleModal();
  showToast('建立中，正在寄信給 '+managersToSend.length+' 位主管...');
  try {
    var url = APPS_SCRIPT_URL + '?action=createSchedule'
      + '&resumeCode=' + encodeURIComponent(cand[resumeKey2]||'')
      + '&name=' + encodeURIComponent(cand.Name||'')
      + '&bu=' + encodeURIComponent(cand['單位']||'')
      + '&jobFunction=' + encodeURIComponent(cand['Job Function']||'')
      + '&round=' + encodeURIComponent(document.getElementById('schedRound').value||'')
      + '&managers=' + encodeURIComponent(JSON.stringify(managersToSend))
      + '&createdByName=' + encodeURIComponent(creatorName)
      + '&createdByEmail=' + encodeURIComponent(creatorEmail)
      + '&createdBy=' + encodeURIComponent(userRole||'');
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'schedule') renderSchedule();
    showToast('✓ 已建立邀約並寄信給 '+managersToSend.length+' 位主管');
  } catch(e) {
    showToast('❌ 建立失敗：'+e.message);
  }
}

function getManagerScheduleLink(token) {
  return APPS_SCRIPT_URL + '?action=managerSchedulePage&token=' + encodeURIComponent(token);
}

function copyManagerLink(btn) {
  var link = btn.getAttribute('data-link');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(function(){ showToast('✓ 已複製主管填寫連結'); }).catch(function(){ prompt('請手動複製連結：', link); });
  } else {
    prompt('請手動複製連結：', link);
  }
}

async function saveCandAvailability(btn) {
  var token = btn.getAttribute('data-token');
  var textarea = document.querySelector('.sched-cand-input[data-token="'+token+'"]');
  var text = textarea ? textarea.value : '';
  showToast('儲存中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=updateCandidateAvailability&token=' + encodeURIComponent(token) + '&text=' + encodeURIComponent(text);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'schedule') renderSchedule();
    showToast('✓ 已儲存候選人／HR 方便時間');
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
  }
}

async function saveFinalTime(btn) {
  var token = btn.getAttribute('data-token');
  var input = document.querySelector('.sched-final-input[data-token="'+token+'"]');
  var text = input ? input.value.trim() : '';
  if (!text) { showToast('請先輸入最終確認時間'); return; }
  showToast('儲存中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=updateFinalTime&token=' + encodeURIComponent(token) + '&text=' + encodeURIComponent(text);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'schedule') renderSchedule();
    showToast('✓ 已標記最終確認時間，請自行通知三方');
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
  }
}

// Recruiter/BP 直接在後台代填主管方便時間（不透過寄信連結）
async function saveManagerAvailability(btn) {
  var token = btn.getAttribute('data-token');
  var textarea = document.querySelector('.sched-mgr-input[data-token="'+token+'"]');
  var text = textarea ? textarea.value : '';
  showToast('儲存中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=updateManagerAvailability&token=' + encodeURIComponent(token) + '&text=' + encodeURIComponent(text);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchData();
    if (currentTab === 'schedule') renderSchedule();
    showToast('✓ 已儲存主管方便時間');
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
  }
}

// ---- 簡易日期／時段關鍵字比對（僅供參考提示，非精準比對，請務必人工再次確認）----
function extractDateHints(text) {
  text = String(text||'');
  var hints = [];
  var m;
  var dateRegex = /(\d{1,2})[\/\-月](\d{1,2})日?/g;
  while ((m = dateRegex.exec(text))) {
    var month = parseInt(m[1]), day = parseInt(m[2]);
    if (month>=1 && month<=12 && day>=1 && day<=31) hints.push(month+'/'+day);
  }
  var weekdayRegex = /(週|周|禮拜|星期)([一二三四五六日天])/g;
  while ((m = weekdayRegex.exec(text))) hints.push('週'+m[2]);
  return [...new Set(hints)];
}

// 抓出文字中的時間段，例如 9:30~11:00、15:00-17:30、9:30到11:00
function extractTimeRanges(text) {
  text = String(text||'');
  var ranges = [];
  var re = /(\d{1,2}):(\d{2})\s*[~\-–到至]\s*(\d{1,2}):(\d{2})/g;
  var m;
  while ((m = re.exec(text))) {
    var start = parseInt(m[1])*60 + parseInt(m[2]);
    var end = parseInt(m[3])*60 + parseInt(m[4]);
    if (end > start) ranges.push({start:start, end:end});
  }
  return ranges;
}

function minutesToHHMM(mins) {
  var h = Math.floor(mins/60), m = mins%60;
  return (h<10?'0'+h:h)+':'+(m<10?'0'+m:m);
}

// 找出雙方時間段裡實際重疊的區間（例如 9:00~11:00 跟 10:00~12:00 → 重疊 10:00~11:00）
function findOverlappingTimeRanges(textA, textB) {
  var a = extractTimeRanges(textA);
  var b = extractTimeRanges(textB);
  var hints = [];
  a.forEach(function(ra){
    b.forEach(function(rb){
      var start = Math.max(ra.start, rb.start);
      var end = Math.min(ra.end, rb.end);
      if (end > start) hints.push(minutesToHHMM(start)+'~'+minutesToHHMM(end));
    });
  });
  return [...new Set(hints)];
}

function findSuggestedOverlap(managerText, candidateText) {
  if (!managerText || !candidateText) return [];
  var mgrHints = extractDateHints(managerText);
  var candHints = extractDateHints(candidateText);
  var dateOverlap = mgrHints.filter(function(h){ return candHints.indexOf(h) >= 0; });
  var timeOverlap = findOverlappingTimeRanges(managerText, candidateText);
  return dateOverlap.concat(timeOverlap);
}

function scheduleStatusStyle(status) {
  if (status === '已確認') return {bg:'var(--teal-bg)', text:'var(--teal-text)'};
  if (status === '待比對確認') return {bg:'#EEF2FF', text:'var(--accent)'};
  if (status === '等待候選人時間' || status === '等待主管填寫') return {bg:'var(--amber-bg)', text:'var(--amber-text)'};
  return {bg:'var(--gray-bg)', text:'var(--gray-text)'};
}

function groupScheduleData() {
  var groups = {};
  var order = [];
  scheduleData.forEach(function(r){
    var gid = r.GroupId || r.Token; // 舊資料沒有 GroupId 的話，自己單獨成一組
    if (!groups[gid]) {
      groups[gid] = { key: gid, name: r.Name, jobFunction: r.JobFunction, round: r.Round,
        createdAt: r.CreatedAt, createdByName: r.CreatedByName, createdByEmail: r.CreatedByEmail, rows: [] };
      order.push(gid);
    }
    groups[gid].rows.push(r);
  });
  return order.map(function(gid){ return groups[gid]; });
}

function renderSchedule() {
  var container = document.getElementById('scheduleList');
  if (!container) return;
  if (!scheduleData.length) {
    container.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">尚無面試時間邀約，點擊右上角「＋ 建立面試時間邀約」開始</div>';
    return;
  }
  var groups = groupScheduleData().sort(function(a,b){
    return String(b.createdAt||'').localeCompare(String(a.createdAt||''));
  });

  container.innerHTML = groups.map(function(g){
    var repToken = g.rows[0].Token;
    var candText = g.rows[0].CandidateAvailability || '';
    var candTokenSafe = String(repToken).replace(/"/g,'&quot;');

    var managerBlocks = g.rows.map(function(r){
      var overlap = findSuggestedOverlap(r.ManagerAvailability, candText);
      var st = scheduleStatusStyle(r.Status);
      var link = getManagerScheduleLink(r.Token);
      var tokenSafe = String(r.Token||'').replace(/"/g,'&quot;');
      return '<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">'+
          '<div style="font-size:13px;font-weight:600;">👤 '+(r.ManagerName||'—')+' <span style="font-weight:400;font-size:11px;color:var(--text-tertiary);">'+(r.ManagerEmail||'')+'</span></div>'+
          '<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:10px;background:'+st.bg+';color:'+st.text+';white-space:nowrap;">'+(r.Status||'')+'</span>'+
        '</div>'+
        '<div style="margin-bottom:8px;">'+
          '<div style="font-size:10px;font-weight:600;color:var(--text-tertiary);margin-bottom:4px;">主管方便時間（可直接在這裡代填，或等主管透過信件連結自己填寫）</div>'+
          '<textarea data-token="'+tokenSafe+'" class="sched-mgr-input" placeholder="例如：7/3(四) 9:30~11:00" style="width:100%;font-size:12px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;min-height:40px;font-family:inherit;resize:vertical;box-sizing:border-box;">'+(r.ManagerAvailability||'')+'</textarea>'+
        '</div>'+
        (overlap.length
          ? '<div style="font-size:12px;background:var(--teal-bg);color:var(--teal-text);padding:8px 10px;border-radius:8px;margin-bottom:8px;">💡 系統偵測到可能重疊：<b>'+overlap.join('、')+'</b>（僅供參考，請人工再次確認實際時間）</div>'
          : (r.ManagerAvailability && candText
            ? '<div style="font-size:12px;background:var(--amber-bg);color:var(--amber-text);padding:8px 10px;border-radius:8px;margin-bottom:8px;">⚠️ 系統無法自動判斷共同時段，請人工比對主管與候選人的時間文字</div>'
            : ''))+
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'+
          '<button class="refresh-btn" style="margin-left:0;" data-token="'+tokenSafe+'" onclick="saveManagerAvailability(this)">儲存主管時間</button>'+
          '<button class="refresh-btn" style="margin-left:0;" data-link="'+link+'" onclick="copyManagerLink(this)">複製主管填寫連結</button>'+
          '<input type="text" class="sched-final-input" data-token="'+tokenSafe+'" placeholder="最終確認時間" value="'+(r.FinalConfirmedTime||'').toString().replace(/"/g,'&quot;')+'" style="flex:1;min-width:150px;font-size:12px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;">'+
          '<button class="lock-btn" style="width:auto;margin-top:0;padding:6px 14px;" data-token="'+tokenSafe+'" onclick="saveFinalTime(this)">確認此時間</button>'+
        '</div>'+
      '</div>';
    }).join('');

    return '<div class="mini-card" style="padding:18px 20px;margin-bottom:16px;">'+
      '<div style="margin-bottom:12px;">'+
        '<div style="font-size:15px;font-weight:700;">'+(g.name||'')+' <span style="font-weight:400;font-size:12px;color:var(--text-secondary);">'+(g.jobFunction||'')+(g.round?' · '+g.round:'')+'</span></div>'+
        '<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">建立人：'+(g.createdByName||'—')+(g.createdByEmail?'（'+g.createdByEmail+'）':'')+' ・ 共邀請 '+g.rows.length+' 位主管</div>'+
      '</div>'+
      '<div style="margin-bottom:14px;">'+
        '<div style="font-size:10px;font-weight:600;color:var(--text-tertiary);margin-bottom:4px;">候選人／HR 方便時間（會套用到下面全部主管）</div>'+
        '<textarea data-token="'+candTokenSafe+'" class="sched-cand-input" placeholder="電訪／Line 詢問候選人後，在此輸入方便時間" style="width:100%;font-size:12px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;min-height:40px;font-family:inherit;resize:vertical;box-sizing:border-box;">'+candText+'</textarea>'+
        '<div style="margin-top:6px;"><button class="refresh-btn" style="margin-left:0;" data-token="'+candTokenSafe+'" onclick="saveCandAvailability(this)">儲存候選人／HR 時間</button></div>'+
      '</div>'+
      managerBlocks+
    '</div>';
  }).join('');
}

// ===== 註冊每個篩選對應要重新渲染的畫面 =====
registerMultiFilterRerender('kb-bu', renderKanban);
registerMultiFilterRerender('kb-job', renderKanban);
registerMultiFilterRerender('cs-result', renderCandidateSearch);
registerMultiFilterRerender('ov-bu', renderOverview);
registerMultiFilterRerender('ov-job', renderOverview);
registerMultiFilterRerender('tr-bu', renderTrends);
registerMultiFilterRerender('tr-job', renderTrends);
registerMultiFilterRerender('tr-result', renderTrends);
registerMultiFilterRerender('cand-bu', renderCandQuery);
registerMultiFilterRerender('cand-job', renderCandQuery);
registerMultiFilterRerender('cand-result', renderCandQuery);
registerMultiFilterRerender('cand-inviter', renderCandQuery);
registerMultiFilterRerender('hc-bu', renderHeadcount);
registerMultiFilterRerender('hc-job', renderHeadcount);
registerMultiFilterRerender('salary-bu', renderSalaryScreen);
registerMultiFilterRerender('salary-job', renderSalaryScreen);

// ---- Candidate Overview：匯出人選資料 ----
var exportSelectedColumns = null; // Set，null 代表尚未初始化（預設全選）

function openExportCandModal() {
  document.getElementById('exportCandModal').style.display = 'flex';
  renderExportModalFilters();
  renderExportColumnList();
  updateExportPreview();
}

function closeExportCandModal() {
  document.getElementById('exportCandModal').style.display = 'none';
}

function renderExportModalFilters() {
  var buOptions = [...new Set(allData.map(function(d){return String(d['單位']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('expBuBar', 'exp-bu', buOptions);
  var jobOptions = buildMultiValueOptions(allData, function(d){return d['Job Function'];});
  renderMultiFilterBar('expJobBar', 'exp-job', jobOptions);
  var inviterOptions = [...new Set(allData.flatMap(function(d){return String(d.Inviter||'').split('、').map(function(s){return s.trim();});}))].filter(Boolean).sort();
  renderMultiFilterDropdown('expInviterBar', 'exp-inviter', inviterOptions, 'Inviter');
  renderMultiFilterDropdown('expResultBar', 'exp-result', getActualResultOptions(), '目前狀態');
}

function getExportMatchedRecords() {
  return allData.filter(function(d){
    return multiFilterPass('exp-bu', d['單位']) && multiFilterPassMulti('exp-job', d['Job Function']) &&
      multiFilterPassMulti('exp-inviter', d.Inviter) && multiFilterPass('exp-result', d.Result) &&
      dateFilterPass('export', d);
  });
}

function updateExportPreview() {
  var el = document.getElementById('expMatchCount');
  if (el) el.textContent = '符合 ' + getExportMatchedRecords().length + ' 筆資料';
}

// 匯出人選資料不需要顯示的欄位：跟人選資料維護與查詢畫面隱藏的欄位相同
function getExportHeaders() {
  var headers = maintainHeaders['Candidate Records'] || (allData.length ? Object.keys(allData[0]).filter(function(k){return k!=='_row';}) : []);
  return headers.filter(function(h){ return MAINTAIN_QUERY_HIDDEN_FIELDS.indexOf(h) < 0; });
}

function renderExportColumnList() {
  var headers = getExportHeaders();
  if (!exportSelectedColumns) exportSelectedColumns = new Set(headers);
  document.getElementById('expColumnList').innerHTML = headers.map(function(h){
    var checked = exportSelectedColumns.has(h);
    var hSafe = String(h).replace(/"/g,'&quot;');
    return '<label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" '+(checked?'checked':'')+' onchange="toggleExportColumn(\''+hSafe+'\',this.checked)"> '+h+'</label>';
  }).join('');
}

function toggleExportColumn(field, checked) {
  if (!exportSelectedColumns) exportSelectedColumns = new Set(getExportHeaders());
  if (checked) exportSelectedColumns.add(field); else exportSelectedColumns.delete(field);
}

function toggleExportAllColumns(selectAll) {
  exportSelectedColumns = selectAll ? new Set(getExportHeaders()) : new Set();
  renderExportColumnList();
}

function csvEscapeVal(v) {
  var s = (v === undefined || v === null) ? '' : String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g,'""') + '"';
  return s;
}

function formatExportFieldValue(field, val) {
  if (!val) return '';
  if (MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0) return fmtDateOnly(val);
  if (MAINTAIN_DATE_FIELDS.indexOf(field) >= 0) return fmtDate(val);
  return val;
}

function doExportCandidates() {
  var headers = getExportHeaders();
  var cols = headers.filter(function(h){ return exportSelectedColumns && exportSelectedColumns.has(h); });
  if (!cols.length) { showToast('❌ 請至少選擇一個要匯出的欄位'); return; }

  var matched = getExportMatchedRecords();
  if (!matched.length) { showToast('❌ 沒有符合篩選條件的人選資料'); return; }

  var rows = [cols.map(csvEscapeVal).join(',')];
  matched.forEach(function(d){
    rows.push(cols.map(function(c){ return csvEscapeVal(formatExportFieldValue(c, d[c])); }).join(','));
  });
  var csvContent = '﻿' + rows.join('\r\n');
  var blob = new Blob([csvContent], {type:'text/csv;charset=utf-8;'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var ts = new Date();
  var fname = '人選資料匯出_' + ts.getFullYear() + String(ts.getMonth()+1).padStart(2,'0') + String(ts.getDate()).padStart(2,'0') + '_' + String(ts.getHours()).padStart(2,'0') + String(ts.getMinutes()).padStart(2,'0') + '.csv';
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('✅ 已匯出 ' + matched.length + ' 筆資料');
  closeExportCandModal();
}

function refreshExportFilters() {
  renderExportModalFilters();
  updateExportPreview();
}
registerMultiFilterRerender('exp-bu', refreshExportFilters);
registerMultiFilterRerender('exp-job', refreshExportFilters);
registerMultiFilterRerender('exp-inviter', refreshExportFilters);
registerMultiFilterRerender('exp-result', refreshExportFilters);

// ============================================================
// ===== 權限管理畫面 =====
// ============================================================

function renderPermissions() {
  renderPermissionWarnings();
  renderUnitHrMappingTable();
  renderHrDirectoryTable();
}

// 統整目前設定裡「跟 Candidate Records 對不起來」的項目，在畫面最上方提醒管理者
function renderPermissionWarnings() {
  var el = document.getElementById('permWarningBanner');
  if (!el) return;
  var msgs = [];

  var directoryNames = hrDirectoryData.map(function(h){ return h['HR姓名']; });
  var missingFromDirectory = permHrOptions.filter(function(n){ return directoryNames.indexOf(n) < 0; });
  if (missingFromDirectory.length) {
    msgs.push('以下「負責HR」在 Candidate Records 中出現過，但尚未加入下方 HR 名冊，這些人暫時無法用自己的名字登入：' + missingFromDirectory.join('、'));
  }

  var invalidHrInMapping = [];
  unitHrMappingData.forEach(function(rec){
    splitMultiValue(rec['負責HR']).forEach(function(hr){
      if (permHrOptions.indexOf(hr) < 0 && invalidHrInMapping.indexOf(hr) < 0) invalidHrInMapping.push(hr);
    });
  });
  if (invalidHrInMapping.length) {
    msgs.push('以下單位對應表中設定的「負責HR」，跟 Candidate Records 目前的選項不一致（可能是舊資料或打字有出入），請確認：' + invalidHrInMapping.join('、'));
  }

  var invalidHrInDirectory = hrDirectoryData.filter(function(h){ return permHrOptions.indexOf(h['HR姓名']) < 0; }).map(function(h){ return h['HR姓名']; });
  if (invalidHrInDirectory.length) {
    msgs.push('以下 HR 名冊中的姓名，跟 Candidate Records 目前的「負責HR」選項不一致：' + invalidHrInDirectory.join('、'));
  }

  if (msgs.length) {
    el.style.display = '';
    el.innerHTML = msgs.map(function(m){ return '⚠️ ' + m; }).join('<br>');
  } else {
    el.style.display = 'none';
    el.innerHTML = '';
  }
}

async function savePermCell(sheet, row, col, value) {
  try {
    var url = APPS_SCRIPT_URL + '?action=editCell&sheet=' + encodeURIComponent(sheet) +
      '&row=' + encodeURIComponent(row) + '&col=' + encodeURIComponent(col) + '&value=' + encodeURIComponent(value);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    return true;
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
    return false;
  }
}

// ---- 單位 → 負責HR 對應表 ----
function renderUnitHrMappingTable() {
  var body = document.getElementById('permUnitMappingBody');
  if (!body) return;
  if (!unitHrMappingData.length) {
    body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-tertiary);padding:20px;">尚無資料，請點下方「＋ 新增單位」開始設定</td></tr>';
    return;
  }
  body.innerHTML = unitHrMappingData.map(function(rec, idx){
    var buVal = String(rec['單位']||'').trim();
    var buInvalid = buVal && permUnitOptions.indexOf(buVal) < 0;
    var buOpts = permUnitOptions.slice();
    if (buVal && buOpts.indexOf(buVal) < 0) buOpts.push(buVal);
    var buOptionsHtml = '<option value="">請選擇單位...</option>' + buOpts.map(function(o){
      var oSafe = String(o).replace(/"/g,'&quot;');
      var oDisp = String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return '<option value="'+oSafe+'" '+(o===buVal?'selected':'')+'>'+(o===buVal&&buInvalid?'⚠️ ':'')+oDisp+'</option>';
    }).join('');
    var buSelect = '<select onchange="updateUnitMappingBu('+idx+',this.value)" style="width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;'+(buInvalid?'color:#EF4444;border-color:#EF4444;':'')+'">'+buOptionsHtml+'</select>';
    return '<tr>'+
      '<td style="padding:8px;">'+buSelect+'</td>'+
      '<td style="padding:8px;">'+buildHrMultiSelectForPermission(rec, idx)+'</td>'+
      '<td style="padding:8px;text-align:center;"><button class="btn-cancel" style="padding:4px 10px;font-size:12px;" onclick="deleteUnitMappingRow('+idx+')">刪除</button></td>'+
    '</tr>';
  }).join('');
}

function buildHrMultiSelectForPermission(rec, idx) {
  var uid = 'permhrms_' + (_dlIdCounter++);
  var selected = splitMultiValue(rec['負責HR']);
  var opts = permHrOptions.slice();
  selected.forEach(function(s){ if (opts.indexOf(s) < 0) opts.push(s); });
  var summary = selected.length ? selected.join('、') : '未選擇';
  var hasInvalid = selected.some(function(s){ return permHrOptions.indexOf(s) < 0; });
  var optionsHtml = opts.map(function(o){
    var checked = selected.indexOf(o) >= 0;
    var invalid = permHrOptions.indexOf(o) < 0;
    var oSafe = String(o).replace(/"/g,'&quot;');
    var oDisp = String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<label class="ms-dropdown-option" style="'+(invalid?'color:#EF4444;':'')+'"><input type="checkbox" '+(checked?'checked':'')+' data-val="'+oSafe+'" onchange="togglePermHrOption('+idx+',this)"> '+(invalid?'⚠️ ':'')+oDisp+'</label>';
  }).join('');
  return '<div class="ms-dropdown" id="'+uid+'" style="width:100%;">'+
    '<button type="button" class="ms-dropdown-toggle" style="width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box;'+(hasInvalid?'color:#EF4444;':'')+'" onclick="toggleMsDropdownPanel(\''+uid+'\')">'+
      '<span>'+(hasInvalid?'⚠️ ':'')+summary.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span> <span class="ms-dropdown-caret">▾</span></button>'+
    '<div class="ms-dropdown-panel" id="'+uid+'-panel" style="display:none;">'+optionsHtml+'</div>'+
  '</div>';
}

async function togglePermHrOption(idx, checkboxEl) {
  var rec = unitHrMappingData[idx];
  if (!rec) return;
  var current = splitMultiValue(rec['負責HR']);
  var val = checkboxEl.getAttribute('data-val');
  var i = current.indexOf(val);
  if (checkboxEl.checked) { if (i < 0) current.push(val); } else if (i >= 0) { current.splice(i,1); }
  var newVal = current.join('、');
  var ok = await savePermCell('Unit HR Mapping', rec._row, 2, newVal);
  if (!ok) { checkboxEl.checked = !checkboxEl.checked; return; }
  rec['負責HR'] = newVal;
  showToast('✓ 已儲存');
  // 只更新這個下拉選單自己的摘要文字與警示樣式，不整個重繪表格，避免選單被關掉、方便一次勾選多個人
  var container = checkboxEl.closest('.ms-dropdown');
  if (container) {
    var selected = splitMultiValue(newVal);
    var hasInvalid = selected.some(function(s){ return permHrOptions.indexOf(s) < 0; });
    var toggleBtn = container.querySelector('.ms-dropdown-toggle');
    var summarySpan = toggleBtn.querySelector('span');
    summarySpan.innerHTML = (hasInvalid?'⚠️ ':'') + (selected.length ? selected.join('、').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '未選擇');
    toggleBtn.style.color = hasInvalid ? '#EF4444' : '';
  }
  renderPermissionWarnings();
}

async function updateUnitMappingBu(idx, newVal) {
  var rec = unitHrMappingData[idx];
  if (!rec) return;
  var ok = await savePermCell('Unit HR Mapping', rec._row, 1, newVal);
  if (ok) { rec['單位'] = newVal; showToast('✓ 已儲存'); renderPermissions(); }
}

async function addUnitMappingRow() {
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('Unit HR Mapping') +
      '&values=' + encodeURIComponent(JSON.stringify(['','']));
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    showToast('新增中...');
    await fetchPermissionData();
    renderPermissions();
  } catch(e) {
    showToast('❌ 新增失敗：'+e.message);
  }
}

async function deleteUnitMappingRow(idx) {
  var rec = unitHrMappingData[idx];
  if (!rec) return;
  if (!confirm('確定要刪除「'+(rec['單位']||'（未設定單位）')+'」這筆單位設定嗎？')) return;
  try {
    var url = APPS_SCRIPT_URL + '?action=deleteRow&sheet=' + encodeURIComponent('Unit HR Mapping') + '&row=' + encodeURIComponent(rec._row);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchPermissionData();
    renderPermissions();
    showToast('✓ 已刪除');
  } catch(e) {
    showToast('❌ 刪除失敗：'+e.message);
  }
}

// ---- HR 名冊管理 ----
function renderHrDirectoryTable() {
  var body = document.getElementById('permHrDirectoryBody');
  if (!body) return;
  if (!hrDirectoryData.length) {
    body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-tertiary);padding:20px;">尚無資料，請點下方「＋ 新增 HR」開始設定</td></tr>';
    return;
  }
  body.innerHTML = hrDirectoryData.map(function(hr, idx){
    var nameVal = String(hr['HR姓名']||'').trim();
    var nameInvalid = nameVal && permHrOptions.indexOf(nameVal) < 0;
    var nameOpts = permHrOptions.slice();
    if (nameVal && nameOpts.indexOf(nameVal) < 0) nameOpts.push(nameVal);
    var nameOptionsHtml = '<option value="">請選擇 HR 姓名...</option>' + nameOpts.map(function(o){
      var oSafe = String(o).replace(/"/g,'&quot;');
      var oDisp = String(o).replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return '<option value="'+oSafe+'" '+(o===nameVal?'selected':'')+'>'+(o===nameVal&&nameInvalid?'⚠️ ':'')+oDisp+'</option>';
    }).join('');
    var nameSelect = '<select onchange="updateHrDirectoryField('+idx+',1,this.value,\'HR姓名\')" style="width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;'+(nameInvalid?'color:#EF4444;border-color:#EF4444;':'')+'">'+nameOptionsHtml+'</select>';
    var roleVal = hr['角色'] === 'BP' ? 'BP' : (hr['角色'] === 'Recruiter' ? 'Recruiter' : '');
    var roleSelect = '<select onchange="updateHrDirectoryField('+idx+',2,this.value,\'角色\')" style="width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;">'+
      '<option value="">請選擇角色...</option>'+
      '<option value="Recruiter" '+(roleVal==='Recruiter'?'selected':'')+'>Recruiter</option>'+
      '<option value="BP" '+(roleVal==='BP'?'selected':'')+'>BP</option>'+
    '</select>';
    return '<tr>'+
      '<td style="padding:8px;">'+nameSelect+'</td>'+
      '<td style="padding:8px;">'+roleSelect+'</td>'+
      '<td style="padding:8px;text-align:center;"><button class="btn-cancel" style="padding:4px 10px;font-size:12px;" onclick="deleteHrDirectoryRow('+idx+')">刪除</button></td>'+
    '</tr>';
  }).join('');
}

async function updateHrDirectoryField(idx, col, newVal, field) {
  var rec = hrDirectoryData[idx];
  if (!rec) return;
  var ok = await savePermCell('HR Directory', rec._row, col, newVal);
  if (ok) { rec[field] = newVal; showToast('✓ 已儲存'); renderPermissions(); }
}

async function addHrDirectoryRow() {
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('HR Directory') +
      '&values=' + encodeURIComponent(JSON.stringify(['','']));
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    showToast('新增中...');
    await fetchPermissionData();
    renderPermissions();
  } catch(e) {
    showToast('❌ 新增失敗：'+e.message);
  }
}

async function deleteHrDirectoryRow(idx) {
  var rec = hrDirectoryData[idx];
  if (!rec) return;
  if (!confirm('確定要刪除「'+(rec['HR姓名']||'（未設定姓名）')+'」這筆 HR 資料嗎？')) return;
  try {
    var url = APPS_SCRIPT_URL + '?action=deleteRow&sheet=' + encodeURIComponent('HR Directory') + '&row=' + encodeURIComponent(rec._row);
    await fetch(noCacheUrl(url), {mode:'no-cors', cache:'no-store'});
    await fetchPermissionData();
    renderPermissions();
    showToast('✓ 已刪除');
  } catch(e) {
    showToast('❌ 刪除失敗：'+e.message);
  }
}

setInterval(fetchData,5*60*1000);

// 設定 logo 圖片（取用 topbar 的同一張 base64）
document.getElementById('roleLogoImg').src = document.querySelector('.topbar-left img').src;

// 進頁面就先抓一次 HR 名冊，畫出「選擇身分」畫面上的按鈕
fetchIdentityData();
