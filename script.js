var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby0h1OkoC_xNWeAAbuh4cBicbTl4B8g1KDtL-s2YK9f80TYjIyxQtdeu9RkWFQVtY3pnw/exec';
var userRole = null;
var allData=[], salaryData=[], scheduleData=[], managerDirectoryData=[], resultOptions=[], positionOptions=[];
var currentTab='kanban';
// 舊的單選篩選狀態變數已改用 multiFilterState（見下方通用多選篩選元件），這裡保留 activeFilter 給 Recruitment Status 用
var activeFilter=null;
var selectedCard=null;

// Stage definitions
var PHONE_STAGES = ['確認主管邀約意願','排電訪','待電訪'];
var INTERVIEW_STAGES = ['確認主管面試意願','排面試','待面試'];
var OFFER_STAGES = ['確認主管錄取意願','確認人選錄取意願','錄取'];
var COLLAPSE_STAGES = ['未回覆','HR不邀約電訪','主管不邀約面試','婉拒電訪','婉拒面試','未錄取','婉拒錄取','已關閉履歷'];
var ALL_ACTIVE_STAGES = PHONE_STAGES.concat(INTERVIEW_STAGES).concat(OFFER_STAGES);

var STAGE_COLORS = {
  '未回覆':'#9CA3AF','排電訪':'#F59E0B','確認主管邀約意願':'#FB923C','待電訪':'#10B981',
  '確認主管面試意願':'#60A5FA','排面試':'#3B82F6','待面試':'#8B5CF6',
  '確認主管錄取意願':'#34D399','確認人選錄取意願':'#059669','錄取':'#16A34A',
  'HR不邀約電訪':'#9CA3AF','主管不邀約面試':'#9CA3AF','婉拒電訪':'#EF4444','婉拒面試':'#EF4444','未錄取':'#EF4444','婉拒錄取':'#EF4444','已關閉履歷':'#6B7280'
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
  var t=(d.Result==='待電訪'||d.Result==='排電訪'||d.Result==='已電訪')?(d.Interview_date||d.PI_date||''):(d.Interview_date||'');
  if (!t) return Infinity;
  var dt=parseDateTime(t); return dt?dt.getTime():Infinity;
}
function isPast(s) {
  if (!s) return false;
  var d=parseDateTime(s); if (!d) return false;
  var y=new Date(); y.setHours(0,0,0,0); return d<y;
}
function isDonePhone(d){return isPast(d.Interview_date||d.PI_date||'');}
function isDoneInterview(d){return isPast(d.Interview_date||'');}

// ===== 共用：日期範圍篩選元件 =====
var dateFilterState = {}; // { pageKey: {field, start, end} }

function buildDateFilterHtml(pageKey, fieldOptions) {
  var optHtml = fieldOptions.map(function(f){return '<option value="'+f.value+'">'+f.label+'</option>';}).join('');
  return '<div class="date-filter-group">'+
    '<div class="filter-group-label">時間篩選</div>'+
    '<div class="date-filter-inputs">'+
      '<select id="df-field-'+pageKey+'" onchange="applyDateFilter(\''+pageKey+'\')">'+optHtml+'</select>'+
      '<input type="date" id="df-start-'+pageKey+'" onchange="applyDateFilter(\''+pageKey+'\')">'+
      '<span style="color:var(--text-tertiary);font-size:12px;">至</span>'+
      '<input type="date" id="df-end-'+pageKey+'" onchange="applyDateFilter(\''+pageKey+'\')">'+
      '<span class="date-filter-clear" onclick="clearDateFilter(\''+pageKey+'\')">清除</span>'+
    '</div>'+
  '</div>';
}

function applyDateFilter(pageKey) {
  var fieldEl = document.getElementById('df-field-'+pageKey);
  var startEl = document.getElementById('df-start-'+pageKey);
  var endEl = document.getElementById('df-end-'+pageKey);
  dateFilterState[pageKey] = {
    field: fieldEl.value,
    start: startEl.value ? new Date(startEl.value+'T00:00:00') : null,
    end: endEl.value ? new Date(endEl.value+'T23:59:59') : null
  };
  triggerPageRerender(pageKey);
}

function clearDateFilter(pageKey) {
  var startEl = document.getElementById('df-start-'+pageKey);
  var endEl = document.getElementById('df-end-'+pageKey);
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  delete dateFilterState[pageKey];
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
    offers: renderOffers,
    candidateSearch: renderCandidateSearch,
    candidateMaintenance: renderCandQuery
  };
  if (renderMap[pageKey]) renderMap[pageKey]();
}

function initDateFilterSlots() {
  var candFields = [
    {value:'invite_date', label:'invite_date'},
    {value:'PI_date', label:'Phone Interview_date'},
    {value:'Interview_date', label:'Interview_date'},
    {value:'Update_date', label:'Update_date'}
  ];
  var csFields = [
    {value:'invite_date', label:'invite_date'},
    {value:'Interview_date', label:'Interview_date'}
  ];
  var slots = {
    'kbDateFilterSlot': {key:'kanban', fields:candFields},
    'ovDateFilterSlot': {key:'overview', fields:candFields},
    'csDateFilterSlot': {key:'candidateSearch', fields:csFields},
    'candDateFilterSlot': {key:'candidateMaintenance', fields:candFields},
    'hcDateFilterSlot': {key:'hc', fields:[{value:'Update_date',label:'Update_date（缺額更新時間，依異動記錄推算暫不支援）'}], disabled:true}
  };
  Object.keys(slots).forEach(function(slotId){
    var el = document.getElementById(slotId);
    if (!el) return;
    var cfg = slots[slotId];
    if (cfg.disabled) { el.innerHTML = ''; return; } // Headcount 沒有日期欄位可篩選，跳過
    if (!dateFilterState[cfg.key]) {
      el.innerHTML = buildDateFilterHtml(cfg.key, cfg.fields);
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
var loadedResources = { core: false, headcount: false, salary: false, scheduling: false };

function setSyncStatus(state, msg) {
  var dot=document.getElementById('syncDot'), txt=document.getElementById('syncText');
  if (dot) dot.className = 'sync-dot' + (state==='loading' ? ' loading' : state==='error' ? ' error' : '');
  if (txt) txt.textContent = msg;
}

async function fetchCoreData() {
  var res = await fetch(APPS_SCRIPT_URL + '?action=getCoreData');
  if (!res.ok) throw new Error('HTTP '+res.status);
  var json = await res.json();
  allData=(json.candidates||[]).filter(function(d){return d.Name&&d.Result;});
  resultOptions=(json.resultOptions||[]).map(function(v){return String(v).trim();}).filter(Boolean);
  positionOptions=(json.positionOptions||[]).map(function(v){return String(v).trim();}).filter(Boolean);
  Object.assign(maintainHeaders, json.sheetHeaders || {});
  loadedResources.core = true;
}

async function fetchHeadcountData() {
  var res = await fetch(APPS_SCRIPT_URL + '?action=getHeadcountData');
  if (!res.ok) throw new Error('HTTP '+res.status);
  var json = await res.json();
  headcountDropdownData = json.headcountDropdowns || {};
  rebuildHeadcountDropdowns();
  Object.assign(maintainHeaders, json.sheetHeaders || {});
  loadHeadcountData(json.headcount||[]);
  loadedResources.headcount = true;
}

async function fetchSalaryData() {
  var res = await fetch(APPS_SCRIPT_URL + '?action=getSalaryData');
  if (!res.ok) throw new Error('HTTP '+res.status);
  var json = await res.json();
  salaryData=(json.salaryRecords||[]).filter(function(d){return d.Company;});
  Object.assign(maintainHeaders, json.sheetHeaders || {});
  loadedResources.salary = true;
}

async function fetchSchedulingData() {
  var res = await fetch(APPS_SCRIPT_URL + '?action=getSchedulingData');
  if (!res.ok) throw new Error('HTTP '+res.status);
  var json = await res.json();
  scheduleData=(json.scheduleRecords||[]).filter(function(d){return d.Token;});
  managerDirectoryData=(json.managerDirectory||[]).filter(function(d){return d.Name;});
  loadedResources.scheduling = true;
}

var RESOURCE_FETCHERS = { core: fetchCoreData, headcount: fetchHeadcountData, salary: fetchSalaryData, scheduling: fetchSchedulingData };

// 切換到某個畫面時呼叫：如果這個畫面需要的資料還沒載入過，才去抓；已經載入過就直接用現有的，不用整份重讀
async function ensureResourceLoaded(resource) {
  if (loadedResources[resource]) return;
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
  kanban:['core'], candidateSearch:['core'], overview:['core'], trends:['core'], offers:['core','headcount'],
  hc:['headcount'], salary:['salary'], schedule:['core','scheduling'], maintain:['core']
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
  if (currentTab === 'offers') renderOffers();
  if (loadedResources.headcount) renderHeadcount();
}

// ---- role selection ----
function selectRole(role) {
  userRole = role;
  document.getElementById('roleScreen').style.display = 'none';
  document.getElementById('mainAppWrapper').style.display = '';

  // 依角色顯示/隱藏 tab
  document.querySelectorAll('.tab[data-tab-role]').forEach(function(t){
    var r = t.getAttribute('data-tab-role');
    t.style.display = r.split(',').indexOf(role) >= 0 ? '' : 'none';
  });

  // 每次選擇身分都重設到第一個 tab，避免殘留前一個角色的畫面狀態
  var firstTab = Array.prototype.find.call(document.querySelectorAll('.tab[data-tab-role]'), function(t){
    return t.getAttribute('data-tab-role').split(',').indexOf(role) >= 0;
  });
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  if (firstTab) {
    firstTab.classList.add('active');
    var onclickAttr = firstTab.getAttribute('onclick');
    var match = onclickAttr.match(/switchTab\('(\w+)'/);
    if (match) {
      currentTab = match[1];
      ['kanban','candidateSearch','overview','hc','maintain','trends','offers','schedule','salary'].forEach(function(v){
        document.getElementById('view-'+v).style.display = v===currentTab ? '' : 'none';
      });
    }
  }

  fetchCoreData().then(function(){
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

function switchRole() {
  userRole = null;
  document.getElementById('mainAppWrapper').style.display = 'none';
  document.getElementById('roleScreen').style.display = 'flex';
}

// ---- tabs ----
async function switchTab(tab,el) {
  currentTab=tab;
  document.querySelectorAll('.tab-bar:first-of-type > .tab').forEach(function(t){t.classList.remove('active');});
  el.classList.add('active');
  ['kanban','candidateSearch','overview','hc','maintain','trends','offers','schedule','salary'].forEach(function(v){
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
  if (tab === 'offers') renderOffers();
  if (tab === 'schedule') renderSchedule();
  if (tab === 'salary') { ensureNewSalaryFieldsRendered(); renderSalaryScreen(); }
}

// ---- filter helpers ----
function toggleFilter(stage){activeFilter=activeFilter===stage?null:stage;renderOverview();}
function toggleCollapse(type){
  var body=document.getElementById('cb-'+type), arrow=document.getElementById('ca-'+type);
  body.classList.toggle('open'); arrow.classList.toggle('open');
}

// 依 電訪/面試/錄取 三個階段組出 Kanban 看板 HTML（Candidate Overview、Candidate Search 共用）
// readOnly=true 時卡片點開後只能查看、不能編輯（給 Candidate Search 用）
function buildKanbanPhasesHtml(filtered, readOnly) {
  var clickFn = readOnly ? 'handleCardClickReadOnly' : 'handleCardClick';
  var phases=[
    {label:'電訪階段', cls:'phase-phone', stages:PHONE_STAGES},
    {label:'面試階段', cls:'phase-interview', stages:INTERVIEW_STAGES},
    {label:'錄取階段', cls:'phase-offer', stages:OFFER_STAGES}
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
          var t=(stage==='待電訪'||stage==='排電訪')?(d.Interview_date||d.PI_date||''):(d.Interview_date||'');
          var timeStr=fmtDate(t);
          var idx=allData.indexOf(d);
          return '<div class="kanban-card" data-idx="'+idx+'" data-stage="'+stage+'" onclick="'+clickFn+'(this)">'
            +'<div class="kanban-card-row1">'
              +'<div class="kanban-card-name">'+d.Name+'</div>'
              +'<div class="kanban-card-right"><span class="kanban-card-pos '+jfClass(d['Job Function'])+'">'+(d['Job Function']||'')+'</span><span class="kanban-card-bu">'+d.BU+'</span></div>'
            +'</div>'
            +(timeStr?'<div class="kanban-card-time">🕐 '+timeStr+'</div>':'')
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

// ---- KANBAN ----
function renderKanban() {
  var search=(document.getElementById('kbSearch')?document.getElementById('kbSearch').value:'').toLowerCase();
  var now=new Date(); now.setHours(0,0,0,0);

  var kbBuOptions = [...new Set(allData.map(function(d){return String(d.BU||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('kbBuBar', 'kb-bu', kbBuOptions);
  var kbJobOptions = [...new Set(allData.map(function(d){return String(d['Job Function']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('kbJobBar', 'kb-job', kbJobOptions);

  // BP 角色的 Candidate Overview 畫面不顯示下拉選單（目前狀態、時間篩選），只保留單位／Job Function 按鈕篩選
  var kbResultGroup = document.getElementById('kbResultGroup');
  var kbResultDivider = document.getElementById('kbResultDivider');
  var kbDateSlot = document.getElementById('kbDateFilterSlot');
  var kbDateDivider = document.getElementById('kbDateDivider');
  if (userRole === 'bp') {
    delete multiFilterState['kb-result'];
    delete dateFilterState['kanban'];
    if (kbResultGroup) kbResultGroup.style.display = 'none';
    if (kbResultDivider) kbResultDivider.style.display = 'none';
    if (kbDateSlot) kbDateSlot.innerHTML = '';
    if (kbDateDivider) kbDateDivider.style.display = 'none';
  } else {
    if (kbResultGroup) kbResultGroup.style.display = '';
    if (kbResultDivider) kbResultDivider.style.display = '';
    if (kbDateDivider) kbDateDivider.style.display = '';
    renderMultiFilterDropdown('kbResultBar', 'kb-result', getResultOptions(), '目前狀態');
  }

  var filtered=allData.filter(function(d){
    if(!multiFilterPass('kb-bu', d.BU)) return false;
    if(!multiFilterPass('kb-job', d['Job Function'])) return false;
    if(!multiFilterPass('kb-result', d.Result)) return false;
    if(search&&!String(d.Name||'').toLowerCase().includes(search)) return false;
    if(!dateFilterPass('kanban', d)) return false;
    // 超過7天未回覆不顯示
    if(d.Result==='未回覆') {
      var inviteDate=parseDateTime(d.invite_date||d['invite date']||'');
      if(!inviteDate) return false;
      var diff=(now-inviteDate)/(1000*60*60*24);
      if(diff>7) return false;
    }
    return true;
  });

  document.getElementById('kanbanBoard').innerHTML = buildKanbanPhasesHtml(filtered);

  // 折疊區
  // 折疊區：除了固定的「結束/不推進」分類，任何不屬於電訪/面試/錄取/結束這幾個既定分類的 Result 值
  // （例如試算表裡新增、但還沒被歸類進上面陣列的狀態）也要能顯示出來，不然這些人選會直接從畫面上消失
  var knownKbStages = PHONE_STAGES.concat(INTERVIEW_STAGES, OFFER_STAGES, COLLAPSE_STAGES);
  var otherKbStages = [...new Set(filtered.map(function(d){ return String(d.Result||'').trim(); }))]
    .filter(function(s){ return s && knownKbStages.indexOf(s) < 0; });
  var collapseStagesToShow = COLLAPSE_STAGES.concat(otherKbStages);

  var collapseHtml='';
  collapseStagesToShow.forEach(function(stage){
    var cands=filtered.filter(function(d){return d.Result===stage;});
    if(!cands.length) return;
    var color=STAGE_COLORS[stage]||'#9CA3AF';
    collapseHtml+='<div class="collapse-section">'
      +'<div class="collapse-hdr" onclick="this.nextElementSibling.classList.toggle(\'open\');this.querySelector(\'.collapse-arrow\').classList.toggle(\'open\')">'
      +'<div class="collapse-hdr-left"><div style="width:10px;height:10px;border-radius:2px;background:'+color+'"></div><span>'+stage+'</span><span class="collapse-count">'+cands.length+' 人</span></div>'
      +'<span class="collapse-arrow">▼</span>'
      +'</div>'
      +'<div class="collapse-body">'
      +'<div class="collapse-grid">'+cands.map(function(d){
        var cidx=allData.indexOf(d);
        return '<div class="mini-card" style="cursor:pointer" data-idx="'+cidx+'" data-stage="'+stage+'" onclick="handleCardClick(this)">'
          +'<div class="mini-card-top"><div class="mini-card-name">'+d.Name+'</div><div class="mini-card-bu">'+d.BU+'</div></div>'
          +'<div class="mini-card-pos">'+(d['Job Function']||'')+'</div>'
          +'<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">點擊更改狀態</div>'
          +'</div>';
      }).join('')+'</div></div></div>';
  });
  document.getElementById('kanbanCollapse').innerHTML=collapseHtml;

  // ---- 轉換率計算 ----
  // 分母：所有狀態非「HR不邀約電訪」的人選；分子：狀態為「錄取」的人選
  var convBase = allData.filter(function(d){
    return multiFilterPass('kb-bu', d.BU) &&
           multiFilterPass('kb-job', d['Job Function']) &&
           d.Result !== 'HR不邀約電訪';
  });
  var convOffer = convBase.filter(function(d){return d.Result==='錄取';});
  var convRate = convBase.length ? (convOffer.length/convBase.length*100) : 0;
  var convEl = document.getElementById('kbConversionRate');
  if (convEl) convEl.textContent = convBase.length ? convRate.toFixed(1)+'%' : '—';
}

// ---- CANDIDATE SEARCH ----
// 搜尋 + 目前狀態篩選 + 時間篩選（僅 invite_date／Interview_date）＋ 電訪/面試/錄取階段 Kanban
function renderCandidateSearch() {
  var search=(document.getElementById('csSearch')?document.getElementById('csSearch').value:'').toLowerCase();

  renderMultiFilterDropdown('csResultBar', 'cs-result', getResultOptions(), '目前狀態');

  var filtered=allData.filter(function(d){
    if(!multiFilterPass('cs-result', d.Result)) return false;
    if(search&&!String(d.Name||'').toLowerCase().includes(search)) return false;
    if(!dateFilterPass('candidateSearch', d)) return false;
    return true;
  });

  document.getElementById('csKanbanBoard').innerHTML = buildKanbanPhasesHtml(filtered, true);
}

// ---- Modal ----
function handleCardClick(el) {
  var idx = parseInt(el.getAttribute('data-idx'));
  var d = allData[idx];
  if (!d) return;
  openEditCandidateModal(d._row);
}

// Candidate Search 專用：卡片點開後僅供查看，不能編輯
function handleCardClickReadOnly(el) {
  var idx = parseInt(el.getAttribute('data-idx'));
  var d = allData[idx];
  if (!d) return;
  openViewCandidateModal(d._row);
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
    {label:'⬇️ 結束/不推進', stages:COLLAPSE_STAGES}
  ];
  // 試算表裡若有新增、但不在上面四個分類中的 Result 選項，歸到「其他狀態」，確保都能被選到
  var knownStages = PHONE_STAGES.concat(INTERVIEW_STAGES, OFFER_STAGES, COLLAPSE_STAGES);
  var otherStages = getResultOptions().filter(function(s){ return knownStages.indexOf(s) < 0; });
  if (otherStages.length) phases.push({label:'其他狀態', stages:otherStages});
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
  var candHeaders = filterCandHeadersForRole(maintainHeaders['Candidate Records'] || Object.keys(cand).filter(function(k){return k!=='_row';}));
  document.getElementById('editCandModalName').textContent = cand.Name || '編輯人選資料';
  document.getElementById('editCandModalFields').innerHTML = candHeaders.map(function(h){
    return renderQueryField('Candidate Records', cand, h, idx);
  }).join('');
  document.getElementById('editCandidateModal').style.display = 'flex';
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
    var res=await fetch(url, {mode:'no-cors'});
    console.log('Response status:', res.status, res.type);
    showToast('✓ 已更新：'+card.name+' → '+newStage);
    var d=allData.find(function(x){return x._row===card.row;});
    if(d) { d.Result=newStage; d.Update_date = getTodayDateStr(); }
    renderAll();
  } catch(e) {
    showToast('❌ 更新失敗：'+e.message);
  }
}

// ---- OVERVIEW ----
function renderOverview() {
  var search=(document.getElementById('ovSearch')?document.getElementById('ovSearch').value:'').toLowerCase();

  var ovBuOptions = [...new Set(allData.map(function(d){return String(d.BU||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('ovBuBar', 'ov-bu', ovBuOptions);
  var ovJobOptions = [...new Set(allData.map(function(d){return String(d['Job Function']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('ovJobBar', 'ov-job', ovJobOptions);

  var filtered=allData.filter(function(d){
    return multiFilterPass('ov-bu', d.BU) &&
           multiFilterPass('ov-job', d['Job Function']) &&
           (!search||String(d.Name||'').toLowerCase().includes(search)) &&
           dateFilterPass('overview', d);
  });
  var activeStages=['排電訪','待電訪','排面試','待面試'];
  document.getElementById('overviewSub').textContent='共 '+filtered.length+' 筆人選資料';
  var timeCls={'排電訪':'t-amber','待電訪':'t-teal','排面試':'t-blue','待面試':'t-purple'};
  var timeIcon={'排電訪':'📅','待電訪':'📞','排面試':'📅','待面試':'🗣️'};
  var timeLabel={'排電訪':'可排電訪時段','待電訪':'電訪時間','排面試':'可排面試時段','待面試':'面試時間'};

  function makeCard(d,stage,cls,icon,label){
    var rawT=(stage==='待電訪'||stage==='排電訪')?(d.Interview_date||d.PI_date||''):(d.Interview_date||'');
    var t=fmtDate(rawT);
    var th=t?'<div class="card-time '+(cls||'t-gray')+'"><span style="font-size:13px">'+(icon||'🕐')+'</span><div><div class="card-time-label">'+(label||'時間')+'</div><div style="font-size:11px;opacity:.85;margin-top:1px">'+t+'</div></div></div>':'<div class="card-time t-gray"><span style="font-size:13px">🕐</span><div><div class="card-time-label">尚未排定時間</div></div></div>';
    return '<div class="card"><div class="card-top"><div class="card-name">'+d.Name+'</div><div class="card-bu">'+d.BU+'</div></div><div class="card-pos">'+(d['Job Function']||'')+(d.Source?' · '+d.Source:'')+'</div>'+th+'</div>';
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

  if (isDateField || isDateOnlyField) {
    // 日期類欄位維持單行 contenteditable，才能套用日期格式清理邏輯
    return '<div contenteditable="true" data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
      'onfocus="enterMaintainEdit(this)" onblur="commitMaintainCell(this)" '+
      'style="font-size:12px;padding:5px 7px;border-radius:6px;min-height:16px;cursor:text;'+widthStyle+'">'+
      (displayVal||'').toString().replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>';
  }

  // 一般文字欄位改用 textarea：支援分行、像 Excel 儲存格一樣可以換行顯示與編輯
  var escapedForTextarea = String(rawVal||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<textarea data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
    'onfocus="enterMaintainEditTA(this)" onblur="commitMaintainCellTA(this)" '+
    'style="font-size:12px;padding:5px 7px;border:1px solid transparent;border-radius:6px;min-height:32px;cursor:text;font-family:inherit;resize:vertical;white-space:pre-wrap;word-break:break-word;'+widthStyle+'" '+
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
  var deptKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Department';}) || 'Department';
  var sectionKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Section';}) || 'Section';
  var jobKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Job Function';}) || 'Job Function';
  var gradeKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='職等';}) || '職等';
  var dutiesKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Duties';}) || 'Duties';
  var reasonKey = Object.keys(hcRawData[0]).find(function(k){return k.includes('Reason');}) || 'Reason for Request';
  var predKey = Object.keys(hcRawData[0]).find(function(k){return k.includes('Predecessor')||k.trim()==='原任';}) || 'Predecessor';
  var succKey = Object.keys(hcRawData[0]).find(function(k){return k.includes('Successor')||k.trim()==='遞補人員';}) || 'Successor';
  var memoKey = Object.keys(hcRawData[0]).find(function(k){return k.trim()==='Memo';}) || 'Memo';

  var hcBuOptions = [...new Set(hcRawData.map(function(r){return String(r[divKey]||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('hcBuBar', 'hc-bu', hcBuOptions);
  var hcJobOptions = [...new Set(hcRawData.map(function(r){return String(r[jobKey]||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('hcJobBar', 'hc-job', hcJobOptions);

  var filtered = hcRawData.filter(function(r){
    return multiFilterPass('hc-bu', r[divKey]) && multiFilterPass('hc-job', r[jobKey]);
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
      unit: [String(r[deptKey]||'').trim(), String(r[sectionKey]||'').trim()].filter(Boolean).join(' / '),
      grade: grade || '—',
      duties: String(r[dutiesKey]||'').trim() || '—',
      reason: String(r[reasonKey]||'').trim() || '—',
      pred: String(r[predKey]||'').trim() || '—',
      succ: succ,
      memo: String(r[memoKey]||'').trim(),
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

      var rowsHtml = displayRows.map(function(rr){
        var r = rr.raw;
        var idx = hcRawData.indexOf(r);
        return '<tr>'+
          '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, deptKey, idx, '100%')+'</td>'+
          '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, sectionKey, idx, '100%')+'</td>'+
          '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, dutiesKey, idx, '100%')+'</td>'+
          '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, reasonKey, idx, '100%')+'</td>'+
          '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, gradeKey, idx, '100%')+'</td>'+
          (isPastMode
            ? '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, succKey, idx, '100%')+'</td>'
            : '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, predKey, idx, '100%')+'</td>')+
          '<td style="padding:2px;">'+renderTableCellInput('Headcount Records', r, memoKey, idx, '100%')+'</td>'+
        '</tr>';
      }).join('');

      return '<div style="margin-bottom:10px;">'+
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">'+
          '<span style="font-size:12px;font-weight:600;">'+j.job+'</span>'+
          '<span style="font-size:11px;font-weight:700;color:'+jc+';background:'+jc+'18;padding:1px 8px;border-radius:10px;">'+countInJob+(isPastMode?' 已補實':' 缺額')+'</span>'+
        '</div>'+
        '<div style="border:1px solid var(--border);border-radius:8px;">'+
          '<table style="width:100%;table-layout:fixed;border-collapse:collapse;">'+
            '<thead><tr style="background:var(--bg);">'+
              '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">部門</th>'+
              '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">單位</th>'+
              '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">Duties</th>'+
              '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">原因</th>'+
              '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">職等</th>'+
              (isPastMode
                ? '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">遞補人員</th>'
                : '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">原任</th>')+
              '<th style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-align:left;padding:5px 6px;">備註</th>'+
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
    await fetch(url, {mode:'no-cors'});
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

// ===== OFFER LIST =====
var _offersNow = new Date();
var offersYear = String(_offersNow.getFullYear());
var offersMonth = String(_offersNow.getMonth()+1);

function offersFilterYearMonth() {
  offersYear = document.getElementById('offersYearSelect').value;
  offersMonth = document.getElementById('offersMonthSelect').value;
  renderOffers();
}

function renderOffers() {
  var search = (document.getElementById('offersSearch')?document.getElementById('offersSearch').value:'').toLowerCase();
  var offers = allData.filter(function(d){ return d.Result === '錄取'; });

  // Onboard date 來源為 Candidate Records 的 Onboard date 欄位
  var yearsSet = [...new Set(offers.map(function(d){
    var t = parseDateTime(d['Onboard date']||'');
    return t ? String(t.getFullYear()) : null;
  }).filter(Boolean))].sort().reverse();
  if (yearsSet.indexOf(offersYear) < 0 && offersYear !== 'all') { if(!yearsSet.length){offersYear='all';} }
  var yearSel = document.getElementById('offersYearSelect');
  if (yearSel) {
    yearSel.innerHTML = '<option value="all">全部年份</option>' +
      yearsSet.map(function(y){return '<option value="'+y+'"'+(offersYear===y?' selected':'')+'>'+y+'年</option>';}).join('');
    yearSel.value = offersYear;
  }
  var monthSel = document.getElementById('offersMonthSelect');
  if (monthSel) {
    var monthOpts = '<option value="all">全部月份</option>';
    for (var mi=1; mi<=12; mi++) monthOpts += '<option value="'+mi+'"'+(offersMonth===String(mi)?' selected':'')+'>'+mi+'月</option>';
    monthSel.innerHTML = monthOpts;
    monthSel.value = offersMonth;
  }

  offers = offers.filter(function(d){
    var t = parseDateTime(d['Onboard date']||'');
    if (!t) return false;
    if (offersYear !== 'all' && String(t.getFullYear()) !== offersYear) return false;
    if (offersMonth !== 'all' && String(t.getMonth()+1) !== offersMonth) return false;
    return true;
  });

  var offersBuOptions = [...new Set(offers.map(function(d){return String(d.BU||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('offersBuBar', 'offers-bu', offersBuOptions);

  var filtered = offers.filter(function(d){
    return multiFilterPass('offers-bu', d.BU) &&
           (!search||String(d.Name||'').toLowerCase().includes(search));
  });
  filtered.sort(function(a,b){
    var ta = parseDateTime(a['Onboard date']||'');
    var tb = parseDateTime(b['Onboard date']||'');
    var tsa = ta?ta.getTime():0, tsb = tb?tb.getTime():0;
    return tsb-tsa;
  });

  var periodLabel = (offersYear==='all'?'全部年份':offersYear+'年') + '・' + (offersMonth==='all'?'全部月份':offersMonth+'月');
  var subEl = document.getElementById('offersSub');
  if (subEl) subEl.textContent = '共 '+filtered.length+' 位錄取人選 · '+periodLabel;

  var bodyEl = document.getElementById('offersTableBody');
  if (!bodyEl) return;
  if (!filtered.length) {
    bodyEl.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-tertiary);padding:24px">目前無錄取人選</td></tr>';
    return;
  }

  var resumeKey = filtered.length ? findResumeCodeKey(filtered[0]) : '履歷代碼';
  bodyEl.innerHTML = filtered.map(function(d){
    return '<tr>'+
      '<td style="font-weight:600;white-space:nowrap">'+d.Name+'</td>'+
      '<td style="white-space:nowrap">'+d.BU+'</td>'+
      '<td style="white-space:nowrap">'+(d['Job Function']||'')+'</td>'+
      '<td style="white-space:nowrap">'+getOfferGradeLevel(d.Name)+'</td>'+
      '<td style="white-space:nowrap">'+(d[resumeKey]||'—')+'</td>'+
      '<td style="white-space:nowrap">'+fmtDateOnly(d['Onboard date']||'')+'</td>'+
    '</tr>';
  }).join('');
}

// 職等：從 Headcount Records 的「遞補人員」欄位比對這位錄取人選的姓名，抓同一列的「職等」欄位
function getOfferGradeLevel(name) {
  if (!name || !hcRawData.length) return '—';
  var match = hcRawData.find(function(h){ return String(h['遞補人員']||'').trim() === String(name).trim(); });
  return (match && match['職等']) ? match['職等'] : '—';
}

// ===== TRENDS =====
var TREND_COLORS = ['#F59E0B','#10B981','#3B82F6','#8B5CF6','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16','#06B6D4','#EF4444','#A855F7','#22C55E','#0EA5E9'];
var trendChartType = { funnel:'line', result:'line' };
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
    });
    svg += '<text x="'+(groupX+groupW/2)+'" y="'+(chartH-padB+16)+'" font-size="9" fill="#6B7280" text-anchor="middle">'+lbl+'</text>';
  });
  svg += '</svg>';
  var legend = series.length>1 ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;">'+series.map(function(s,i){
    return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-secondary);"><div style="width:8px;height:8px;border-radius:2px;background:'+TREND_COLORS[i%TREND_COLORS.length]+'"></div>'+s.name+'</div>';
  }).join('')+'</div>' : '';
  document.getElementById(containerId).innerHTML = svg + legend;
}

function drawTrendTable(headId, bodyId, labels, series) {
  document.getElementById(headId).innerHTML = '<th>項目</th>' + labels.map(function(l){return '<th style="text-align:center">'+l+'</th>';}).join('');
  var rows = series.map(function(s, si){
    var cells = s.data.map(function(v){
      return '<td style="text-align:center;'+(v>0?'font-weight:600;color:'+TREND_COLORS[si%TREND_COLORS.length]+';':'color:var(--text-tertiary);')+'">'+v+'</td>';
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

function renderTrendCard(card) {
  var c = trendCache[card];
  if (!c) return;
  var chartId = 'trend'+card.charAt(0).toUpperCase()+card.slice(1)+'Chart';
  drawChart(chartId, trendChartType[card], c.labels, c.series, c.maxVal);
}

function renderTrends() {
  var today = new Date(); today.setHours(0,0,0,0);

  // ---- 週次（最近8週，週日期加上星期）----
  var weeks = [];
  for (var w=7;w>=0;w--) { var we=getWeekEnd(today); we.setDate(we.getDate()-w*7); weeks.push(we); }
  var weekLabels = weeks.map(fmtTrendWeekLabel);

  // ---- 每週邀約／電訪／面試人數（合併圖表＋表格）----
  var inviteCounts = weeks.map(function(we){
    var ws = new Date(we); ws.setDate(ws.getDate()-6);
    return allData.filter(function(rec){
      var iv = parseDateTime(rec.invite_date || rec['invite date'] || '');
      if (!iv) return false;
      iv.setHours(0,0,0,0);
      return iv >= ws && iv <= we;
    }).length;
  });
  var piCounts = weeks.map(function(we){
    var ws = new Date(we); ws.setDate(ws.getDate()-6);
    return allData.filter(function(rec){
      var pd = parseDateTime(rec.PI_date || '');
      if (!pd) return false;
      pd.setHours(0,0,0,0);
      return pd >= ws && pd <= we;
    }).length;
  });
  var interviewCounts = weeks.map(function(we){
    var ws = new Date(we); ws.setDate(ws.getDate()-6);
    return allData.filter(function(rec){
      var id = parseDateTime(rec.Interview_date || '');
      if (!id) return false;
      id.setHours(0,0,0,0);
      return id >= ws && id <= we;
    }).length;
  });
  var funnelSeries = [
    {name:'邀約人數', data:inviteCounts},
    {name:'電訪人數', data:piCounts},
    {name:'面試人數', data:interviewCounts}
  ];
  var funnelMax = 1;
  funnelSeries.forEach(function(s){ s.data.forEach(function(v){ if(v>funnelMax) funnelMax=v; }); });
  funnelMax = Math.ceil(funnelMax*1.2);
  trendCache.funnel = { labels: weekLabels, series: funnelSeries, maxVal: funnelMax };
  renderTrendCard('funnel');
  drawTrendTable('trendFunnelTableHead','trendFunnelTableBody', weekLabels, funnelSeries);

  // ---- 每週 Result 狀態統計（依 Update_date，最近8週）----
  var allStages = [...new Set(allData.map(function(d){return d.Result;}))].filter(Boolean);
  var resultSeries = allStages.map(function(stage, si){
    var data = weeks.map(function(we){
      var ws = new Date(we); ws.setDate(ws.getDate()-6);
      return allData.filter(function(rec){
        if (rec.Result !== stage) return false;
        var ud = parseDateTime(rec.Update_date || rec['Update date'] || '');
        if (!ud) return false;
        ud.setHours(0,0,0,0);
        return ud >= ws && ud <= we;
      }).length;
    });
    return {name: stage, data: data};
  });
  var resultMax = 1;
  resultSeries.forEach(function(s){ s.data.forEach(function(v){ if(v>resultMax) resultMax=v; }); });
  resultMax = Math.ceil(resultMax*1.2);
  trendCache.result = { labels: weekLabels, series: resultSeries, maxVal: resultMax };
  renderTrendCard('result');
  drawTrendTable('trendResultTableHead','trendResultTableBody', weekLabels, resultSeries);
}

// ===== 資料維護 =====
// ===== 資料維護 =====
var maintainSheet = 'Candidate Records';
var maintainHeaders = {};
var maintainBU = 'all';
// candFilterBU/Job/Result 已改用 multiFilterState（cand-bu / cand-job / cand-result）
// salaryBU/salaryJob 已改用 multiFilterState（salary-bu / salary-job）

// 備用清單：試算表尚未設定資料驗證、或資料還沒載入完成時使用
var FALLBACK_RESULT_OPTIONS = ['未回覆','排電訪','待電訪','確認主管邀約意願','確認主管面試意願','排面試','待面試','確認主管錄取意願','確認人選錄取意願','婉拒電訪','HR不邀約電訪','HR不邀約面試','主管不邀約面試','婉拒面試','錄取','未錄取','婉拒錄取','已面試，排複試','已關閉履歷','思考一下','???'];

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
  return state.selected.has(String(rawValue||'').trim());
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
  if (!e.target.closest('.ms-dropdown')) {
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

function getResultOptions() {
  var base = (resultOptions && resultOptions.length) ? resultOptions.slice() : FALLBACK_RESULT_OPTIONS.slice();
  // 保險：不管試算表的資料驗證有沒有讀取成功，畫面上實際出現過的 Result 值一定要能被篩選/選到
  var actualValues = [...new Set(allData.map(function(d){ return String(d.Result||'').trim(); }))].filter(Boolean);
  actualValues.forEach(function(v){ if (base.indexOf(v) < 0) base.push(v); });
  return base;
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
    'BU': function(){ return [...new Set(allData.map(function(d){return String(d.BU||'').trim();}))].filter(Boolean).sort(); },
    'Job Function': function(){ return [...new Set(allData.map(function(d){return String(d['Job Function']||'').trim();}))].filter(Boolean).sort(); },
    '104_Position': function(){ return getPositionOptions(); },
    'Source': function(){ return [...new Set(allData.map(function(d){return String(d.Source||'').trim();}))].filter(Boolean).sort(); },
    'Inviter': function(){ return [...new Set(allData.map(function(d){return String(d.Inviter||'').trim();}))].filter(Boolean).sort(); },
    'Result': function(){ return getResultOptions(); },
    '性別': function(){ return [...new Set(allData.map(function(d){return String(d['性別']||'').trim();}))].filter(Boolean).sort(); },
    '最高學歷': function(){ return [...new Set(allData.map(function(d){return String(d['最高學歷']||'').trim();}))].filter(Boolean).sort(); }
  },
  'Headcount Records': {}
};

var MAINTAIN_DATE_FIELDS = ['invite_date','invite date','PI_date','Interview_date','Update_date','Update date','Onboard date'];
var MAINTAIN_DATEONLY_FIELDS = ['invite_date','invite date','Update_date','Update date','Onboard date'];

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

function renderCandQuery() {
  var search = (document.getElementById('candQuerySearch').value || '').trim().toLowerCase();
  var container = document.getElementById('candQueryResults');
  var hasDateFilter = dateFilterState.candidateMaintenance &&
    (dateFilterState.candidateMaintenance.start || dateFilterState.candidateMaintenance.end);

  var candBuOptions = [...new Set(allData.map(function(d){return String(d.BU||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('candBuBar', 'cand-bu', candBuOptions);
  var candJobOptions = [...new Set(allData.map(function(d){return String(d['Job Function']||'').trim();}))].filter(Boolean).sort();
  renderMultiFilterBar('candJobBar', 'cand-job', candJobOptions);
  renderMultiFilterDropdown('candResultBar', 'cand-result', getResultOptions(), '目前狀態');

  if (!search && !isMultiFilterNarrowed('cand-bu') && !isMultiFilterNarrowed('cand-job') && !isMultiFilterNarrowed('cand-result') && !hasDateFilter) {
    container.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">請輸入姓名或履歷代碼查詢，或使用上方篩選條件顯示人選</div>';
    return;
  }

  var matched = allData.filter(function(d){
    var resumeKey = findResumeCodeKey(d);
    var textMatch = !search || String(d.Name||'').toLowerCase().includes(search) || String(d[resumeKey]||'').toLowerCase().includes(search);
    return textMatch && multiFilterPass('cand-bu', d.BU) && multiFilterPass('cand-job', d['Job Function']) && multiFilterPass('cand-result', d.Result) && dateFilterPass('candidateMaintenance', d);
  });

  if (!matched.length) {
    container.innerHTML = '<div class="empty" style="padding:30px 0;text-align:center;">找不到符合的人選</div>';
    return;
  }

  container.innerHTML = matched.map(function(cand){
    var idx = allData.indexOf(cand);
    var candHeaders = filterCandHeadersForRole(maintainHeaders['Candidate Records'] || Object.keys(cand).filter(function(k){return k!=='_row';}));
    var isSelected = selectedCandForCopy && selectedCandForCopy._row === cand._row;

    var fieldsHtml = candHeaders.map(function(h){
      // 資料維護頁採緊湊欄寬，僅職缺名稱與備註保留較大的編輯空間。
      var isWide = (h === '104_Position' || h.indexOf('Memo') >= 0);
      return renderQueryField('Candidate Records', cand, h, idx, isWide ? 'span2' : false);
    }).join('');

    return '<div class="mini-card" style="padding:20px 22px;margin-bottom:16px;'+(isSelected?'border-color:var(--accent);box-shadow:0 0 0 2px var(--accent);':'')+'">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">'+
        '<div style="font-size:16px;font-weight:700;">'+cand.Name+(isSelected?' <span style="font-size:11px;font-weight:600;color:var(--accent);">（已選取，將用於複製）</span>':'')+'</div>'+
        '<div style="display:flex;gap:8px;">'+
          '<button class="refresh-btn" style="margin-left:0;" onclick="selectCandForCopy('+cand._row+')">📌 選取以複製</button>'+
          '<button class="refresh-btn" style="margin-left:0;color:#EF4444;border-color:#EF4444;" onclick="deleteMaintainRow('+cand._row+')">🗑️ 刪除人選資料</button>'+
        '</div>'+
      '</div>'+
      '<div class="maintain-candidate-grid">'+fieldsHtml+'</div>'+
    '</div>';
  }).join('');
}

function renderQueryField(sheetName, rec, field, idx, fullWidth) {
  var rawVal = rec[field] !== undefined ? rec[field] : '';
  var col = (maintainHeaders[sheetName] || Object.keys(rec)).indexOf(field) + 1;
  var dropdowns = MAINTAIN_DROPDOWNS[sheetName] || {};
  var isDateField = MAINTAIN_DATE_FIELDS.indexOf(field) >= 0;
  var isDateOnlyField = MAINTAIN_DATEONLY_FIELDS.indexOf(field) >= 0;
  var displayVal = isDateOnlyField ? fmtDateOnly(rawVal) : isDateField ? fmtDate(rawVal) : rawVal;
  var rawSafe = String(rawVal||'').replace(/"/g,'&quot;');
  var wrapStyle = fullWidth === 'span2' ? 'grid-column:span 2;' : fullWidth ? 'grid-column:1/-1;' : '';

  var inputHtml;
  if (dropdowns[field]) {
    var options = dropdowns[field]();
    inputHtml = buildDropdownDatalistInput(sheetName, rec, field, col, idx, options,
      'width:100%;font-size:13px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);box-sizing:border-box;');
  } else if (fullWidth) {
    inputHtml = '<textarea data-sheet="'+sheetName+'" data-row="'+rec._row+'" data-col="'+col+'" data-field="'+field+'" data-idx="'+idx+'" data-raw="'+rawSafe+'" '+
      'onfocus="this.dataset.original=this.value" onblur="commitMaintainTextarea(this)" rows="2" '+
      'style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;resize:vertical;font-family:inherit;white-space:pre-wrap;word-break:break-word;">'+(rawVal||'')+'</textarea>';
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

// ---- Headcount Records 表格模式 ----
function maintainFilter(type, val, el) {
  if (type === 'bu') maintainBU = val;
  document.querySelectorAll('#maintainBuBar .bu-btn').forEach(function(b){b.classList.remove('active');});
  el.classList.add('active');
  renderMaintain();
}

function renderMaintain() {
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
    var jobs = [...new Set(salaryData.map(function(r){return String(r[jobKey]||'').trim();}))].filter(Boolean).sort();
    renderMultiFilterBar('salaryJobBar', 'salary-job', jobs);
  } else {
    var jobBarEl = document.getElementById('salaryJobBar');
    if (jobBarEl) jobBarEl.innerHTML = '';
  }

  var search = (document.getElementById('salarySearch')?document.getElementById('salarySearch').value:'').toLowerCase();
  var records = salaryData.filter(function(r){
    var buMatch = !buKey || multiFilterPass('salary-bu', r[buKey]);
    var jobMatch = !jobKey || multiFilterPass('salary-job', r[jobKey]);
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
    await fetch(url, {mode:'no-cors'});
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
    await fetch(url, {mode:'no-cors'});
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
    await fetch(url, {mode:'no-cors'});
    var records = getMaintainRecords(sheet);
    var rec = records[idx];
    if (rec) {
      rec[field] = newVal;
      // 跟後端一致：Candidate Records / Market Salary Records 只要有任何欄位被改動，畫面上也立即帶出今天的 Update_date
      var updateFieldName = sheet === 'Candidate Records' ? 'Update_date' : (sheet === 'Market Salary Records' ? 'Update date' : null);
      if (updateFieldName && field !== updateFieldName) {
        var todayStr = getTodayDateStr();
        rec[updateFieldName] = todayStr;
        var updEl = document.querySelector('[data-sheet="'+sheet+'"][data-row="'+row+'"][data-field="'+updateFieldName+'"]');
        if (updEl) {
          updEl.setAttribute('data-raw', todayStr);
          if (updEl.tagName === 'SELECT' || updEl.tagName === 'INPUT' || updEl.tagName === 'TEXTAREA') updEl.value = todayStr;
          else updEl.textContent = fmtDateOnly(todayStr);
        }
      }
    }
    showToast('✓ 已儲存');
    return true;
  } catch(e) {
    showToast('❌ 儲存失敗：'+e.message);
    return false;
  }
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
var COPY_CLEAR_FIELDS = ['PI_date','Interview_date','Result','Update_date','Update date','Onboard date','Memo'];

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

function renderNewCandidateFields() {
  var headers = maintainHeaders['Candidate Records'] || ['invite_date','BU','Job Function','104_Position','Name','性別','年齡','最高學歷','學校','科系','履歷代碼','Source','Inviter','PI_date','Interview_date','Result','Update_date','Onboard date','Memo'];
  var dropdowns = MAINTAIN_DROPDOWNS['Candidate Records'] || {};
  var requiredFields = ['Name','Result','invite_date'];
  var todayStr = getTodayDateStr();

  document.getElementById('newCandFields').innerHTML = headers.map(function(h){
    var isRequired = requiredFields.indexOf(h) >= 0;
    var label = h + (isRequired ? ' <span style="color:#EF4444;">*</span>' : '');
    var isInviteDate = (h === 'invite_date' || h === 'invite date');
    var isMemo = h.indexOf('Memo') >= 0;
    var isPosition = h === '104_Position';
    var isNameOrResume = (h === 'Name' || h.indexOf('履歷代碼') >= 0);
    var spanStyle = isMemo ? 'grid-column:1/-1;' : (isPosition ? 'grid-column:span 2;' : '');
    var dupAttr = isNameOrResume ? ' oninput="checkNewCandDuplicate()"' : '';
    var prefillVal = isInviteDate ? todayStr : '';

    if (dropdowns[h]) {
      var options = dropdowns[h]();
      return '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+buildFormDatalistInput('new-cand-input', h, options, prefillVal)+'</div>';
    }
    return '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" class="new-cand-input" data-field="'+h+'" value="'+prefillVal+'"'+dupAttr+' style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"></div>';
  }).join('');

  document.getElementById('newCandDupWarning').style.display = 'none';
}

// 輸入姓名或履歷代碼時，即時檢查這位人選是否已經有紀錄，避免重複建檔
function checkNewCandDuplicate() {
  var name = '', resume = '';
  document.querySelectorAll('#newCandFields .new-cand-input').forEach(function(inp){
    var f = inp.getAttribute('data-field');
    if (f === 'Name') name = inp.value.trim().toLowerCase();
    if (f && f.indexOf('履歷代碼') >= 0) resume = inp.value.trim().toLowerCase();
  });
  var warnEl = document.getElementById('newCandDupWarning');
  if (!name && !resume) { warnEl.style.display = 'none'; return; }

  var matched = allData.filter(function(d){
    var resumeKey = findResumeCodeKey(d);
    return (name && String(d.Name||'').toLowerCase()===name) || (resume && String(d[resumeKey]||'').toLowerCase()===resume);
  });
  if (matched.length) {
    warnEl.style.display = '';
    warnEl.innerHTML = '⚠️ 已經有相符的紀錄：' + matched.map(function(m){
      return (m.Name||'') + '（' + (m['履歷代碼']||'') + '）目前狀態：' + (m.Result||'—');
    }).join('；') + '，請確認是否要繼續新增，避免重複建檔';
  } else {
    warnEl.style.display = 'none';
  }
}

// 點選下方人選資料卡，標記為「要複製的來源」
function selectCandForCopy(row) {
  var cand = allData.find(function(d){ return d._row === row; });
  if (!cand) return;
  selectedCandForCopy = cand;
  document.getElementById('newCandSelectedHint').textContent = '已選取「'+(cand.Name||'')+'」，點擊「複製人選資料」套用到上方表單';
  renderCandQuery();
}

// 把選取的人選資料套用到常駐表單（Name、履歷代碼會一起複製；104_Position 與流程紀錄類欄位不複製）
function applyCopyToNewCandidateForm() {
  if (!selectedCandForCopy) { showToast('請先在下方人選清單點選要複製的人選'); return; }
  var todayStr = getTodayDateStr();
  document.querySelectorAll('#newCandFields .new-cand-input').forEach(function(inp){
    var f = inp.getAttribute('data-field');
    var isInviteDate = (f === 'invite_date' || f === 'invite date');
    var isPosition = f.indexOf('104') >= 0;
    if (isInviteDate) { inp.value = todayStr; return; }
    if (isPosition || COPY_CLEAR_FIELDS.indexOf(f) >= 0) { inp.value = ''; return; }
    inp.value = selectedCandForCopy[f] || '';
  });
  showToast('✓ 已複製「'+(selectedCandForCopy.Name||'')+'」的資料，可修改後再新增');
  checkNewCandDuplicate();
}

function clearNewCandidateForm() {
  selectedCandForCopy = null;
  document.getElementById('newCandSelectedHint').textContent = '';
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

  var orderedValues = headers.map(function(h){ return values[h] || ''; });
  showToast('新增中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('Candidate Records') +
      '&values=' + encodeURIComponent(JSON.stringify(orderedValues));
    await fetch(url, {mode:'no-cors'});
    await fetchData();
    selectedCandForCopy = null;
    document.getElementById('newCandSelectedHint').textContent = '';
    renderNewCandidateFields();
    renderCandQuery();
    showToast('✓ 已新增人選資料');
  } catch(e) {
    showToast('❌ 新增失敗：'+e.message);
  }
}

// Candidate Overview 畫面的「＋ 新增人選資料」：重用共用的 addRowModal，直接寫入 Candidate Records
function openKbNewCandidateModal() {
  var headers = filterCandHeadersForRole(maintainHeaders['Candidate Records'] || ['invite_date','BU','Job Function','104_Position','Name','性別','年齡','最高學歷','學校','科系','履歷代碼','Source','Inviter','PI_date','Interview_date','Result','Update_date','Onboard date','Memo']);
  var dropdowns = MAINTAIN_DROPDOWNS['Candidate Records'] || {};
  var requiredFields = ['Name','Result','invite_date'];
  var todayStr = getTodayDateStr();

  document.getElementById('addRowModalSub').textContent = '新增全新人選至 Candidate Records';
  document.getElementById('addRowModalFields').innerHTML = headers.map(function(h){
    var isRequired = requiredFields.indexOf(h) >= 0;
    var label = h + (isRequired ? ' <span style="color:#EF4444;">*</span>' : '');
    var isInviteDate = (h === 'invite_date' || h === 'invite date');
    var isMemo = h.indexOf('Memo') >= 0;
    var spanStyle = isMemo ? 'grid-column:1/-1;' : '';
    var prefillVal = isInviteDate ? todayStr : '';

    if (dropdowns[h]) {
      var options = dropdowns[h]();
      return '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div>'+buildFormDatalistInput('kb-new-cand-input', h, options, prefillVal)+'</div>';
    }
    var valAttr = prefillVal ? ' value="'+prefillVal+'"' : '';
    return '<div style="'+spanStyle+'"><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" data-field="'+h+'" class="kb-new-cand-input" style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"'+valAttr+'></div>';
  }).join('');

  document.querySelector('#addRowModal .modal').classList.add('modal-wide');
  document.getElementById('addRowModal').style.display = 'flex';
  window._kbNewCandidateMode = true;
}

async function submitKbNewCandidate() {
  var headers = maintainHeaders['Candidate Records'] || [];
  var requiredFields = ['Name','Result','invite_date'];
  var values = {};
  var missing = [];
  document.querySelectorAll('#addRowModalFields .kb-new-cand-input').forEach(function(inp){
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
  window._kbNewCandidateMode = false;
  closeAddRowModal();
  showToast('新增中...');
  try {
    var url = APPS_SCRIPT_URL + '?action=addRow&sheet=' + encodeURIComponent('Candidate Records') +
      '&values=' + encodeURIComponent(JSON.stringify(orderedValues));
    await fetch(url, {mode:'no-cors'});
    await fetchData();
    if (currentTab === 'kanban') renderKanban();
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
  document.getElementById('addRowModal').style.display = 'flex';
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
    var valAttr = prefillVal ? ' value="'+String(prefillVal).replace(/"/g,'&quot;')+'"' : '';
    return '<div><div class="modal-label" style="margin-bottom:4px;">'+label+'</div><input type="text" data-field="'+h+'" class="hc-new-row-input" style="width:100%;font-size:13px;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;box-sizing:border-box;"'+valAttr+'></div>';
  }).join('');

  document.querySelector('#addRowModal .modal').classList.add('modal-wide');
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
    await fetch(url, {mode:'no-cors'});
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
  window._kbNewCandidateMode = false;
  window._hcNewRowMode = false;
}

function handleAddRowModalSubmit() {
  if (window._kbNewCandidateMode) submitKbNewCandidate();
  else if (window._hcNewRowMode) submitHcNewRow();
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
    await fetch(url, {mode:'no-cors'});
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
    await fetch(url, {mode:'no-cors'});
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
      + '&bu=' + encodeURIComponent(cand.BU||'')
      + '&jobFunction=' + encodeURIComponent(cand['Job Function']||'')
      + '&round=' + encodeURIComponent(document.getElementById('schedRound').value||'')
      + '&managers=' + encodeURIComponent(JSON.stringify(managersToSend))
      + '&createdByName=' + encodeURIComponent(creatorName)
      + '&createdByEmail=' + encodeURIComponent(creatorEmail)
      + '&createdBy=' + encodeURIComponent(userRole||'');
    await fetch(url, {mode:'no-cors'});
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
    await fetch(url, {mode:'no-cors'});
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
    await fetch(url, {mode:'no-cors'});
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
    await fetch(url, {mode:'no-cors'});
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
registerMultiFilterRerender('kb-result', renderKanban);
registerMultiFilterRerender('cs-result', renderCandidateSearch);
registerMultiFilterRerender('ov-bu', renderOverview);
registerMultiFilterRerender('ov-job', renderOverview);
registerMultiFilterRerender('cand-bu', renderCandQuery);
registerMultiFilterRerender('cand-job', renderCandQuery);
registerMultiFilterRerender('cand-result', renderCandQuery);
registerMultiFilterRerender('hc-bu', renderHeadcount);
registerMultiFilterRerender('hc-job', renderHeadcount);
registerMultiFilterRerender('salary-bu', renderSalaryScreen);
registerMultiFilterRerender('salary-job', renderSalaryScreen);
registerMultiFilterRerender('offers-bu', renderOffers);

setInterval(fetchData,5*60*1000);

// 設定 logo 圖片（取用 topbar 的同一張 base64）
document.getElementById('roleLogoImg').src = document.querySelector('.topbar-left img').src;
