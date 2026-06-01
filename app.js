/* 유앤김 패밀리 가계부 — 앱 로직
   - localStorage 자동 저장
   - 거래 추가/수정/삭제 모달
   - 월/유형/구성원/카테고리/검색 필터
   - 페이지네이션
   - 대시보드 · 월별 · 카테고리 · 구성원 자동 렌더
   - GitHub Gist 자동 클라우드 동기화
   - JSON 내보내기/가져오기
*/

const STORAGE_KEY = 'yukim_ledger_v1';
const SYNC_KEY = 'yukim_ledger_sync_v1';
const FILE_NAME = '유앤김_가계부_데이터.json';
const GIST_FILENAME = 'yukim_ledger.json';
const PULL_INTERVAL_MS = 30000;
const PUSH_DEBOUNCE_MS = 2000;
const PAGE_SIZE = 30;

function deepClone(o){return JSON.parse(JSON.stringify(o))}

let DATA = (()=>{
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){const p = JSON.parse(raw); if(p && p.transactions) return p;}
  }catch(e){}
  return deepClone(window.INITIAL_DATA);
})();

// ---------- 유틸 ----------
function escape(s){if(s==null) return '';return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmtKRW(n){if(!n) return '0';return Math.round(n).toLocaleString('ko-KR')}
function fmtShort(n){
  n = Math.round(n||0);
  const abs = Math.abs(n);
  if(abs>=1e8) return (n/1e8).toFixed(1)+'억';
  if(abs>=1e4) return (n/1e4).toFixed(0)+'만';
  return n.toLocaleString();
}
function typeKey(t){return t==='수입'?'inc':t==='지출'?'exp':'trf'}
function sign(t){return t==='수입'?'+':t==='지출'?'-':''}
function getMonth(d){return (d||'').slice(0,7)}

// ---------- 저장 ----------
function saveData(silent, opts){
  opts = opts || {};
  if(!opts.fromRemote){
    DATA.updatedAt = new Date().toISOString();
  }
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
    if(!silent) flashSync('saved');
  }catch(e){
    toast('저장 실패: 공간 부족', 'err');
  }
  if(!opts.fromRemote){
    const cfg = getSyncConfig();
    if(cfg.enabled && cfg.token && cfg.gistId) schedulePush();
  }
}
function flashSync(state){
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncText');
  if(!dot) return;
  if(state==='dirty'){dot.classList.add('dirty');txt.textContent='저장 중…'}
  else if(state==='syncing'){dot.classList.add('dirty');txt.textContent='동기화 중…'}
  else if(state==='cloud'){dot.classList.remove('dirty');txt.textContent='☁ 클라우드 동기화'}
  else{dot.classList.remove('dirty');txt.textContent='자동 저장됨'}
}

// ---------- 토스트 ----------
let toastTimer;
function toast(msg, kind){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (kind||'');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2400);
}

// ---------- 뷰 라우팅 ----------
function showView(v){
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.toggle('active', t.dataset.view===v));
  window.scrollTo({top:0, behavior:'smooth'});
}
document.querySelectorAll('.nav-tab').forEach(t=>t.addEventListener('click', ()=>showView(t.dataset.view)));
document.getElementById('settingsBtn').addEventListener('click', ()=>showView('settings'));

// ---------- 집계 ----------
function aggregate(filters){
  filters = filters || {};
  const tx = DATA.transactions.filter(t=>{
    if(filters.month && filters.month!=='all' && getMonth(t.date)!==filters.month) return false;
    if(filters.type && filters.type!=='all' && t.type!==filters.type) return false;
    if(filters.user && filters.user!=='all' && t.user!==filters.user) return false;
    if(filters.cat && filters.cat!=='all' && t.cat!==filters.cat) return false;
    if(filters.text){
      const q = filters.text.toLowerCase();
      const blob = `${t.desc||''} ${t.memo||''} ${t.cat||''} ${t.method||''}`.toLowerCase();
      if(!blob.includes(q)) return false;
    }
    return true;
  });
  const sum = {inc:0, exp:0, trf:0, cnt:tx.length};
  tx.forEach(t=>{
    if(t.type==='수입') sum.inc += t.amount;
    else if(t.type==='지출') sum.exp += t.amount;
    else sum.trf += t.amount;
  });
  return {tx, sum};
}

function monthlyAgg(){
  const m = {};
  DATA.transactions.forEach(t=>{
    const k = getMonth(t.date);
    if(!k) return;
    if(!m[k]) m[k] = {inc:0,exp:0,trf:0,cnt:0};
    m[k][typeKey(t.type)] += t.amount;
    m[k].cnt += 1;
  });
  return Object.keys(m).sort().map(k=>({month:k, ...m[k]}));
}

function categoryAgg(filters){
  const {tx} = aggregate(filters);
  const c = {};
  tx.forEach(t=>{
    const k = t.cat || '기타';
    if(!c[k]) c[k] = {amount:0, cnt:0, type:t.type};
    c[k].amount += t.amount;
    c[k].cnt += 1;
  });
  return Object.entries(c).map(([cat,v])=>({cat, ...v})).sort((a,b)=>b.amount-a.amount);
}

function memberAgg(month){
  const m = {};
  DATA.meta.users.forEach(u=>m[u] = {inc:0,exp:0,trf:0,cnt:0});
  DATA.transactions.forEach(t=>{
    if(month && month!=='all' && getMonth(t.date)!==month) return;
    if(!m[t.user]) m[t.user] = {inc:0,exp:0,trf:0,cnt:0};
    m[t.user][typeKey(t.type)] += t.amount;
    m[t.user].cnt += 1;
  });
  return m;
}

// ---------- 렌더: 대시보드 ----------
function renderDash(){
  document.getElementById('updatedDate').textContent = DATA.updated || '';
  const {sum} = aggregate({});
  document.getElementById('kpiInc').textContent = fmtKRW(sum.inc) + '원';
  document.getElementById('kpiExp').textContent = fmtKRW(sum.exp) + '원';
  document.getElementById('kpiBal').textContent = fmtKRW(sum.inc - sum.exp) + '원';
  document.getElementById('kpiCnt').textContent = sum.cnt + '건';
  document.getElementById('totalCnt').textContent = sum.cnt;

  const months = monthlyAgg();
  if(months.length){
    document.getElementById('periodText').textContent = months[0].month + ' ~ ' + months[months.length-1].month;
  }

  // Monthly cards
  const mg = document.getElementById('dashMonthGrid');
  mg.innerHTML = months.map(m=>{
    const mNum = parseInt(m.month.slice(5,7));
    const bal = m.inc - m.exp;
    return `<div class="month-card" data-month="${m.month}">
      <div class="month-card-top">
        <div class="month-num">${mNum}<span>월</span></div>
        <div class="month-cnt">${m.cnt}건</div>
      </div>
      <div class="month-line inc"><span>수입</span><b>+${fmtShort(m.inc)}</b></div>
      <div class="month-line exp"><span>지출</span><b>-${fmtShort(m.exp)}</b></div>
      <div class="month-line bal"><span>순익</span><b>${bal>=0?'+':''}${fmtShort(bal)}</b></div>
    </div>`;
  }).join('') || '<div class="empty">거래 데이터가 없습니다</div>';
  mg.querySelectorAll('[data-month]').forEach(el=>{
    el.addEventListener('click', ()=>{
      document.getElementById('txFilterMonth').value = el.dataset.month;
      filterTx();
      showView('txlist');
    });
  });

  // Top categories (지출만)
  const cats = categoryAgg({type:'지출'}).slice(0, 8);
  const max = Math.max(...cats.map(c=>c.amount), 1);
  document.getElementById('dashTopCats').innerHTML = cats.map(c=>{
    const pct = (c.amount/max*100).toFixed(1);
    const totalPct = (c.amount / aggregate({type:'지출'}).sum.exp * 100).toFixed(1);
    return `<div class="cat-row">
      <div class="cat-name">${escape(c.cat)}</div>
      <div class="cat-track"><div class="cat-fill exp" style="width:${pct}%"></div></div>
      <div class="cat-amt">${fmtKRW(c.amount)}원<span class="cat-pct">(${totalPct}%)</span></div>
    </div>`;
  }).join('') || '<div class="empty">지출 데이터 없음</div>';
}

// ---------- 렌더: 월별 ----------
function renderMonthly(){
  const months = monthlyAgg();
  const cont = document.getElementById('monthlyContainer');
  if(!months.length){ cont.innerHTML='<div class="empty">데이터 없음</div>'; return; }
  cont.innerHTML = months.map(m=>{
    const mNum = parseInt(m.month.slice(5,7));
    const bal = m.inc - m.exp;
    return `<div class="panel">
      <div class="panel-head">
        <div class="panel-title"><span class="ic">${mNum}</span>${m.month} · ${mNum}월</div>
        <div style="font-size:13px;color:var(--text-muted)">${m.cnt}건</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:12px">
        <div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">수입</div><div style="font-family:'Noto Serif KR';font-size:22px;color:var(--inc);font-weight:700">+${fmtKRW(m.inc)}</div></div>
        <div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">지출</div><div style="font-family:'Noto Serif KR';font-size:22px;color:var(--exp);font-weight:700">-${fmtKRW(m.exp)}</div></div>
        <div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">순익</div><div style="font-family:'Noto Serif KR';font-size:22px;color:var(--navy);font-weight:700">${bal>=0?'+':''}${fmtKRW(bal)}</div></div>
      </div>
      ${renderMonthCategories(m.month)}
    </div>`;
  }).join('');
}
function renderMonthCategories(month){
  const cats = categoryAgg({month, type:'지출'}).slice(0, 5);
  if(!cats.length) return '<div class="empty">지출 거래 없음</div>';
  const max = Math.max(...cats.map(c=>c.amount), 1);
  return `<div style="margin-top:10px;padding-top:14px;border-top:1px dashed var(--border)">
    <div style="font-size:11.5px;color:var(--gold-deep);font-weight:700;letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px">지출 TOP 5 카테고리</div>
    ${cats.map(c=>`<div class="cat-row">
      <div class="cat-name">${escape(c.cat)}</div>
      <div class="cat-track"><div class="cat-fill exp" style="width:${(c.amount/max*100).toFixed(1)}%"></div></div>
      <div class="cat-amt">${fmtKRW(c.amount)}원</div>
    </div>`).join('')}
  </div>`;
}

// ---------- 렌더: 거래내역 ----------
let txPage = 1;
let txFilters = {month:'all', type:'all', user:'all', cat:'all', text:''};

function buildSelectOptions(){
  const months = [...new Set(DATA.transactions.map(t=>getMonth(t.date)))].sort();
  const mSel = ['txFilterMonth','catFilterMonth','memFilterMonth'];
  mSel.forEach(id=>{
    const s = document.getElementById(id);
    if(!s) return;
    const cur = s.value;
    s.innerHTML = `<option value="all">${id==='catFilterMonth'||id==='memFilterMonth'?'전체 기간':'전체 월'}</option>` +
      months.map(m=>`<option value="${m}">${m}</option>`).join('');
    s.value = cur || 'all';
  });
  const uSel = document.getElementById('txFilterUser');
  uSel.innerHTML = '<option value="all">전체 구성원</option>' + DATA.meta.users.map(u=>`<option value="${u}">${escape(u)}</option>`).join('');
  const cSel = document.getElementById('txFilterCat');
  cSel.innerHTML = '<option value="all">전체 카테고리</option>' + DATA.meta.categories.map(c=>`<option value="${c}">${escape(c)}</option>`).join('');
  // modal selects
  document.getElementById('fUser').innerHTML = DATA.meta.users.map(u=>`<option value="${u}">${escape(u)}</option>`).join('');
  document.getElementById('fCat').innerHTML = DATA.meta.categories.map(c=>`<option value="${c}">${escape(c)}</option>`).join('');
  document.getElementById('fMethod').innerHTML = DATA.meta.methods.map(m=>`<option value="${m}">${escape(m)}</option>`).join('');
}

function renderTxList(){
  const {tx} = aggregate(txFilters);
  // sort desc by date+id
  tx.sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.id||0)-(a.id||0));
  const total = tx.length;
  const pages = Math.max(1, Math.ceil(total/PAGE_SIZE));
  if(txPage > pages) txPage = 1;
  const slice = tx.slice((txPage-1)*PAGE_SIZE, txPage*PAGE_SIZE);

  document.getElementById('txCount').textContent = `${total}건`;
  document.getElementById('txListBody').innerHTML = slice.map(t=>{
    const k = typeKey(t.type);
    const d = t.date.slice(5).replace('-','/');
    return `<div class="tx-row" data-tx-id="${t.id}">
      <div class="tx-date"><b>${d}</b><span>${t.date.slice(0,4)}</span></div>
      <div class="tx-body">
        <div class="desc">${escape(t.desc||'(설명 없음)')}</div>
        <div class="meta">
          <span class="type-tag ${k}">${t.type}</span>
          <span class="dot"></span>
          <span>${escape(t.cat||'-')}</span>
          ${t.memo?`<span class="dot"></span><span>${escape(t.memo)}</span>`:''}
        </div>
      </div>
      <div class="tx-method">${escape(t.method||'-')}</div>
      <div class="tx-user">${escape(t.user||'-')}</div>
      <div class="tx-amt ${k}">${sign(t.type)}${fmtKRW(t.amount)}원</div>
    </div>`;
  }).join('') || '<div class="empty">조건에 맞는 거래가 없습니다</div>';

  document.getElementById('txListBody').querySelectorAll('[data-tx-id]').forEach(el=>{
    el.addEventListener('click', ()=>openEditModal(parseInt(el.dataset.txId)));
  });

  // pagination
  const pg = document.getElementById('txPages');
  if(pages <= 1){ pg.innerHTML=''; return; }
  const winSize = 5;
  const start = Math.max(1, txPage - 2);
  const end = Math.min(pages, start + winSize - 1);
  let html = `<button class="pg-btn" ${txPage<=1?'disabled':''} data-pg="prev">‹</button>`;
  if(start>1){ html += `<button class="pg-btn" data-pg="1">1</button>${start>2?'<span style="padding:8px 4px;color:var(--text-light)">…</span>':''}`}
  for(let i=start; i<=end; i++) html += `<button class="pg-btn ${i===txPage?'active':''}" data-pg="${i}">${i}</button>`;
  if(end<pages){ html += `${end<pages-1?'<span style="padding:8px 4px;color:var(--text-light)">…</span>':''}<button class="pg-btn" data-pg="${pages}">${pages}</button>`}
  html += `<button class="pg-btn" ${txPage>=pages?'disabled':''} data-pg="next">›</button>`;
  pg.innerHTML = html;
  pg.querySelectorAll('[data-pg]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const v = b.dataset.pg;
      if(v==='prev') txPage = Math.max(1, txPage-1);
      else if(v==='next') txPage = Math.min(pages, txPage+1);
      else txPage = parseInt(v);
      renderTxList();
      document.getElementById('view-txlist').scrollIntoView({behavior:'smooth', block:'start'});
    });
  });
}

function filterTx(){
  txFilters = {
    month: document.getElementById('txFilterMonth').value,
    type: document.getElementById('txFilterType').value,
    user: document.getElementById('txFilterUser').value,
    cat: document.getElementById('txFilterCat').value,
    text: document.getElementById('txFilterText').value.trim()
  };
  txPage = 1;
  renderTxList();
}
['txFilterMonth','txFilterType','txFilterUser','txFilterCat'].forEach(id=>{
  document.addEventListener('DOMContentLoaded', ()=>{});
});

// ---------- 렌더: 카테고리 ----------
function renderCategory(){
  const month = document.getElementById('catFilterMonth').value;
  const type = document.getElementById('catFilterType').value;
  const cats = categoryAgg({month, type:type==='all'?undefined:type});
  if(!cats.length){ document.getElementById('catList').innerHTML='<div class="empty">데이터 없음</div>'; return; }
  const total = cats.reduce((s,c)=>s+c.amount, 0);
  const max = Math.max(...cats.map(c=>c.amount), 1);
  document.getElementById('catList').innerHTML = cats.map(c=>{
    const pct = (c.amount/max*100).toFixed(1);
    const totalPct = total ? (c.amount/total*100).toFixed(1) : '0';
    const tk = c.type==='수입'?'inc':c.type==='지출'?'exp':'trf';
    return `<div class="cat-row">
      <div class="cat-name">${escape(c.cat)}</div>
      <div class="cat-track"><div class="cat-fill ${tk}" style="width:${pct}%"></div></div>
      <div class="cat-amt">${fmtKRW(c.amount)}원<span class="cat-pct">${c.cnt}건·${totalPct}%</span></div>
    </div>`;
  }).join('');
}

// ---------- 렌더: 구성원 ----------
function renderMember(){
  const month = document.getElementById('memFilterMonth').value;
  const m = memberAgg(month);
  document.getElementById('memGrid').innerHTML = Object.entries(m).map(([user, v])=>{
    const bal = v.inc - v.exp;
    return `<div class="mem-card">
      <h3>${escape(user)}</h3>
      <div class="mem-cnt">거래 ${v.cnt}건</div>
      <div class="mem-row inc"><span>수입</span><b>+${fmtKRW(v.inc)}원</b></div>
      <div class="mem-row exp"><span>지출</span><b>-${fmtKRW(v.exp)}원</b></div>
      <div class="mem-row"><span>이체</span><b>${fmtKRW(v.trf)}원</b></div>
      <div class="mem-row bal"><span>순익</span><b style="color:${bal>=0?'var(--inc)':'var(--exp)'}">${bal>=0?'+':''}${fmtKRW(bal)}원</b></div>
    </div>`;
  }).join('');
}

// ---------- 편집 모달 ----------
let editingId = null;
let modalType = '지출';

function openEditModal(id){
  editingId = id;
  if(id){
    const t = DATA.transactions.find(x=>x.id===id);
    if(!t) return;
    modalType = t.type;
    document.getElementById('modalTitle').textContent = '거래 수정';
    document.getElementById('modalSub').textContent = t.date + ' · ' + (t.desc||'');
    document.getElementById('fDate').value = t.date;
    document.getElementById('fAmount').value = t.amount.toLocaleString();
    document.getElementById('fUser').value = t.user;
    document.getElementById('fCat').value = t.cat;
    document.getElementById('fMethod').value = t.method;
    document.getElementById('fDesc').value = t.desc || '';
    document.getElementById('fMemo').value = t.memo || '';
    document.getElementById('btnDelete').style.display = 'inline-flex';
  } else {
    modalType = '지출';
    document.getElementById('modalTitle').textContent = '새 거래 추가';
    document.getElementById('modalSub').textContent = '날짜와 금액을 입력하세요';
    document.getElementById('fDate').value = new Date().toISOString().slice(0,10);
    document.getElementById('fAmount').value = '';
    document.getElementById('fUser').value = DATA.meta.users[0];
    document.getElementById('fCat').value = DATA.meta.categories[0];
    document.getElementById('fMethod').value = DATA.meta.methods[0];
    document.getElementById('fDesc').value = '';
    document.getElementById('fMemo').value = '';
    document.getElementById('btnDelete').style.display = 'none';
  }
  updateTypePicker();
  document.getElementById('modalBg').classList.add('active');
  setTimeout(()=>document.getElementById('fAmount').focus(), 100);
}
function closeModal(){
  document.getElementById('modalBg').classList.remove('active');
  editingId = null;
}
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalBg').addEventListener('click', e=>{if(e.target.id==='modalBg') closeModal()});
document.addEventListener('keydown', e=>{if(e.key==='Escape') closeModal()});

function updateTypePicker(){
  document.querySelectorAll('.type-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.type===modalType);
  });
}
document.querySelectorAll('.type-btn').forEach(b=>{
  b.addEventListener('click', ()=>{modalType = b.dataset.type; updateTypePicker()});
});

document.getElementById('fAmount').addEventListener('input', e=>{
  const v = e.target.value.replace(/[^\d]/g,'');
  e.target.value = v ? parseInt(v).toLocaleString() : '';
});

document.getElementById('fabAdd').addEventListener('click', ()=>openEditModal(null));

document.getElementById('modalSave').addEventListener('click', ()=>{
  const date = document.getElementById('fDate').value;
  const amount = parseInt(document.getElementById('fAmount').value.replace(/[^\d]/g,'')) || 0;
  if(!date){ toast('날짜를 입력하세요', 'err'); return; }
  if(amount<=0){ toast('금액을 입력하세요', 'err'); return; }
  const rec = {
    date, amount, type: modalType,
    user: document.getElementById('fUser').value,
    cat: document.getElementById('fCat').value,
    method: document.getElementById('fMethod').value,
    desc: document.getElementById('fDesc').value.trim(),
    memo: document.getElementById('fMemo').value.trim()
  };
  flashSync('dirty');
  if(editingId){
    const t = DATA.transactions.find(x=>x.id===editingId);
    if(t) Object.assign(t, rec);
  } else {
    rec.id = DATA.nextId || (Math.max(0, ...DATA.transactions.map(x=>x.id||0)) + 1);
    DATA.nextId = rec.id + 1;
    DATA.transactions.push(rec);
  }
  saveData();
  rerenderAll();
  closeModal();
  toast(editingId ? '거래 수정됨' : '거래 추가됨', 'ok');
});

document.getElementById('btnDelete').addEventListener('click', ()=>{
  if(!editingId) return;
  if(!confirm('이 거래를 삭제하시겠습니까?')) return;
  flashSync('dirty');
  DATA.transactions = DATA.transactions.filter(x=>x.id!==editingId);
  saveData();
  rerenderAll();
  closeModal();
  toast('거래 삭제됨', 'ok');
});

// ---------- 전체 리렌더 ----------
function rerenderAll(){
  buildSelectOptions();
  renderDash();
  renderMonthly();
  renderTxList();
  renderCategory();
  renderMember();
}

// ---------- 필터 이벤트 ----------
function bindFilters(){
  ['txFilterMonth','txFilterType','txFilterUser','txFilterCat'].forEach(id=>{
    document.getElementById(id).addEventListener('change', filterTx);
  });
  document.getElementById('txFilterText').addEventListener('input', filterTx);
  document.getElementById('catFilterMonth').addEventListener('change', renderCategory);
  document.getElementById('catFilterType').addEventListener('change', renderCategory);
  document.getElementById('memFilterMonth').addEventListener('change', renderMember);
}

// ---------- 백업/복원 ----------
document.getElementById('btnExport').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(DATA, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = FILE_NAME;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('JSON 다운로드 완료', 'ok');
});
document.getElementById('btnImport').addEventListener('click', ()=>document.getElementById('fileImport').click());
document.getElementById('fileImport').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const p = JSON.parse(ev.target.result);
      if(!p.transactions) throw new Error('형식이 올바르지 않습니다');
      if(!confirm('현재 데이터를 덮어쓰시겠습니까?')) return;
      DATA = p;
      saveData(true);
      rerenderAll();
      toast('가져오기 완료', 'ok');
    }catch(err){
      toast('가져오기 실패: '+err.message, 'err');
    }
  };
  reader.readAsText(file, 'utf-8');
  e.target.value = '';
});
document.getElementById('btnReset').addEventListener('click', ()=>{
  if(!confirm('초기 데이터로 복원합니다. 계속할까요?')) return;
  DATA = deepClone(window.INITIAL_DATA);
  saveData(true);
  rerenderAll();
  toast('초기 데이터로 복원되었습니다', 'ok');
});

// ============ GitHub Gist 자동 동기화 ============
function getSyncConfig(){
  try{return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}')}catch{return {}}
}
function setSyncConfig(c){localStorage.setItem(SYNC_KEY, JSON.stringify(c))}

function encodeSyncCode(token, gistId){
  const raw = token + ':' + gistId;
  return 'ledgerSync:' + btoa(unescape(encodeURIComponent(raw)));
}
function decodeSyncCode(code){
  if(!code) return null;
  const m = String(code).trim().match(/^(?:ledgerSync|dkbiSync):(.+)$/);
  if(!m) return null;
  try{
    const raw = decodeURIComponent(escape(atob(m[1])));
    const i = raw.indexOf(':');
    if(i<0) return null;
    return {token: raw.slice(0,i), gistId: raw.slice(i+1)};
  }catch{return null}
}

async function ghFetch(url, opts, token){
  opts = opts || {};
  opts.headers = Object.assign({'Accept':'application/vnd.github+json','Authorization':'token '+token}, opts.headers||{});
  const res = await fetch(url, opts);
  if(!res.ok){
    let msg = res.status + ' ' + res.statusText;
    try{const j = await res.json(); if(j.message) msg += ' — ' + j.message}catch{}
    throw new Error(msg);
  }
  return res.json();
}
async function createGist(token, data){
  return ghFetch('https://api.github.com/gists', {
    method:'POST',
    body: JSON.stringify({
      description:'유앤김 패밀리 가계부 자동 동기화 (private)',
      public:false,
      files:{[GIST_FILENAME]:{content: JSON.stringify(data, null, 2)}}
    })
  }, token);
}
async function readGist(token, gistId){
  const j = await ghFetch('https://api.github.com/gists/'+encodeURIComponent(gistId), {}, token);
  const file = j.files && j.files[GIST_FILENAME];
  if(!file) throw new Error('Gist에서 데이터 파일을 찾을 수 없습니다');
  let content = file.content;
  if(file.truncated && file.raw_url){
    const r = await fetch(file.raw_url);
    content = await r.text();
  }
  return JSON.parse(content);
}
async function updateGist(token, gistId, data){
  return ghFetch('https://api.github.com/gists/'+encodeURIComponent(gistId), {
    method:'PATCH',
    body: JSON.stringify({files:{[GIST_FILENAME]:{content: JSON.stringify(data, null, 2)}}})
  }, token);
}

function setSyncBadge(state){
  const badge = document.getElementById('syncStateBadge');
  if(!badge) return;
  badge.classList.remove('off','on','syncing');
  if(state==='on'){badge.classList.add('on');badge.textContent='ON'}
  else if(state==='syncing'){badge.classList.add('syncing');badge.textContent='SYNCING'}
  else{badge.classList.add('off');badge.textContent='OFF'}
}
function setSyncStatusText(s){const el=document.getElementById('syncStatusText');if(el) el.textContent=s}
function setSyncLastTime(d){
  const el = document.getElementById('syncLastTime');
  if(!el) return;
  if(!d){el.textContent='-';return}
  const diff = Date.now() - new Date(d).getTime();
  if(diff<10000) el.textContent='방금 전';
  else if(diff<60000) el.textContent=Math.floor(diff/1000)+'초 전';
  else if(diff<3600000) el.textContent=Math.floor(diff/60000)+'분 전';
  else el.textContent=new Date(d).toLocaleString('ko-KR');
}
function refreshSyncUI(){
  const cfg = getSyncConfig();
  const s1 = document.getElementById('syncStep1');
  const s2 = document.getElementById('syncStep2');
  if(cfg.enabled && cfg.token && cfg.gistId){
    s1.style.display='none'; s2.style.display='block';
    document.getElementById('syncGistId').textContent = cfg.gistId.slice(0,8)+'...'+cfg.gistId.slice(-4);
    document.getElementById('syncCodeOut').value = encodeSyncCode(cfg.token, cfg.gistId);
    setSyncBadge('on'); setSyncLastTime(cfg.lastSync); flashSync('cloud');
  } else {
    s1.style.display='block'; s2.style.display='none';
    setSyncBadge('off');
  }
}

let pushTimer=null, pushInflight=false;
function schedulePush(){
  setSyncBadge('syncing'); setSyncStatusText('업로드 대기 중…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doPush, PUSH_DEBOUNCE_MS);
}
async function doPush(){
  const cfg = getSyncConfig();
  if(!cfg.enabled || !cfg.token || !cfg.gistId) return;
  if(pushInflight){schedulePush(); return}
  pushInflight = true;
  try{
    setSyncBadge('syncing'); setSyncStatusText('클라우드에 업로드 중…'); flashSync('syncing');
    await updateGist(cfg.token, cfg.gistId, DATA);
    cfg.lastSync = new Date().toISOString();
    setSyncConfig(cfg);
    setSyncBadge('on'); setSyncStatusText('연결됨'); setSyncLastTime(cfg.lastSync); flashSync('cloud');
  }catch(e){
    setSyncBadge('on'); setSyncStatusText('업로드 실패: '+e.message);
    toast('동기화 업로드 실패: '+e.message, 'err');
  }finally{pushInflight = false}
}
let pullTimer=null, pullInflight=false;
async function doPull(silent){
  const cfg = getSyncConfig();
  if(!cfg.enabled || !cfg.token || !cfg.gistId) return;
  if(pullInflight) return;
  pullInflight = true;
  try{
    if(!silent){setSyncBadge('syncing'); setSyncStatusText('서버에서 확인 중…'); flashSync('syncing')}
    const remote = await readGist(cfg.token, cfg.gistId);
    if(remote && remote.updatedAt && remote.updatedAt > (DATA.updatedAt||'')){
      DATA = remote;
      saveData(true, {fromRemote:true});
      rerenderAll();
      if(!silent) toast('다른 기기 변경사항을 가져왔습니다', 'ok');
    }
    cfg.lastSync = new Date().toISOString();
    setSyncConfig(cfg);
    setSyncBadge('on'); setSyncStatusText('연결됨'); setSyncLastTime(cfg.lastSync); flashSync('cloud');
  }catch(e){
    setSyncBadge('on'); setSyncStatusText('확인 실패: '+e.message);
    if(!silent) toast('동기화 확인 실패: '+e.message, 'err');
  }finally{pullInflight = false}
}
function startPullLoop(){clearInterval(pullTimer); pullTimer = setInterval(()=>doPull(true), PULL_INTERVAL_MS)}
function stopPullLoop(){clearInterval(pullTimer); pullTimer = null}

window.addEventListener('focus', ()=>{
  const cfg = getSyncConfig();
  if(cfg.enabled) doPull(true);
});
window.addEventListener('beforeunload', ()=>{
  if(pushTimer){
    const cfg = getSyncConfig();
    if(cfg.enabled && cfg.token && cfg.gistId){
      try{
        const xhr = new XMLHttpRequest();
        xhr.open('PATCH', 'https://api.github.com/gists/'+encodeURIComponent(cfg.gistId), false);
        xhr.setRequestHeader('Authorization','token '+cfg.token);
        xhr.setRequestHeader('Accept','application/vnd.github+json');
        xhr.send(JSON.stringify({files:{[GIST_FILENAME]:{content: JSON.stringify(DATA)}}}));
      }catch{}
    }
  }
});

document.getElementById('btnSyncStart').addEventListener('click', async ()=>{
  const t = document.getElementById('ghToken').value.trim();
  const c = document.getElementById('ghSyncCode').value.trim();
  const btn = document.getElementById('btnSyncStart');
  btn.disabled = true; btn.textContent = '연결 중…';
  try{
    let token, gistId;
    if(c){
      const dec = decodeSyncCode(c);
      if(!dec) throw new Error('동기화 코드 형식이 올바르지 않습니다');
      token = dec.token; gistId = dec.gistId;
      const remote = await readGist(token, gistId);
      if(remote && remote.updatedAt && remote.updatedAt > (DATA.updatedAt||'')){
        DATA = remote;
        saveData(true, {fromRemote:true});
        rerenderAll();
      }
    } else if(t){
      if(!/^gh[ps]_/.test(t) && !/^github_pat_/.test(t)){
        if(!confirm('토큰 형식이 일반적이지 않습니다. 계속할까요?')){btn.disabled=false; btn.textContent='☁️ 동기화 시작'; return}
      }
      token = t;
      const g = await createGist(token, DATA);
      gistId = g.id;
    } else {
      throw new Error('토큰 또는 동기화 코드를 입력하세요');
    }
    setSyncConfig({enabled:true, token, gistId, lastSync: new Date().toISOString()});
    refreshSyncUI();
    startPullLoop();
    toast('자동 동기화 시작됨', 'ok');
    document.getElementById('ghToken').value = '';
    document.getElementById('ghSyncCode').value = '';
  }catch(e){
    toast('동기화 시작 실패: '+e.message, 'err');
  }finally{btn.disabled = false; btn.textContent = '☁️ 동기화 시작'}
});
document.getElementById('btnSyncStop').addEventListener('click', ()=>{
  if(!confirm('자동 동기화를 끄시겠습니까?')) return;
  setSyncConfig({});
  stopPullLoop();
  clearTimeout(pushTimer);
  refreshSyncUI();
  flashSync('saved');
  toast('동기화 꺼짐');
});
document.getElementById('btnSyncNow').addEventListener('click', async ()=>{await doPush(); await doPull()});
document.getElementById('btnCopyCode').addEventListener('click', async ()=>{
  const code = document.getElementById('syncCodeOut').value;
  try{
    await navigator.clipboard.writeText(code);
    toast('동기화 코드 복사 완료 — 다른 기기에 붙여넣으세요', 'ok');
  }catch{
    document.getElementById('syncCodeOut').select();
    document.execCommand('copy');
    toast('동기화 코드 복사 완료', 'ok');
  }
});

(function bootSync(){
  const cfg = getSyncConfig();
  refreshSyncUI();
  if(cfg.enabled && cfg.token && cfg.gistId){
    doPull(true);
    startPullLoop();
  }
  setInterval(()=>{
    const c = getSyncConfig();
    if(c.enabled && c.lastSync) setSyncLastTime(c.lastSync);
  }, 5000);
})();

// ============ 입력·업로드 페이지 ============

// 수동 입력 카드 클릭 → 기존 모달
document.getElementById('imManual').addEventListener('click', ()=>openEditModal(null));
document.getElementById('imExcel').addEventListener('click', ()=>document.getElementById('excelFile').click());
document.getElementById('imScan').addEventListener('click', ()=>document.getElementById('scanFile').click());

// ---------- 엑셀 업로드 ----------
let excelRows = [];     // 원본 행
let excelHeaders = [];  // 컬럼명 배열
let excelMapping = {};  // {date: '날짜', amount: '금액', ...}
let excelDefaults = {}; // {type:'지출', user:'유재진', method:'...', cat:'...'}

const FIELD_KEYS = [
  {k:'date', label:'날짜', hints:['날짜','date','일자','거래일','일시']},
  {k:'amount', label:'금액', hints:['금액','amount','거래금액','이용금액','출금액','입금액','입금','출금']},
  {k:'desc', label:'설명/적요', hints:['내용','적요','설명','desc','description','거래내용','가맹점','상호','place']},
  {k:'memo', label:'메모', hints:['메모','memo','note','비고']},
  {k:'type', label:'유형 (수입/지출/이체)', hints:['유형','type','구분']},
  {k:'cat', label:'카테고리', hints:['카테고리','cat','category','분류','용도']},
  {k:'method', label:'결제수단', hints:['결제수단','method','수단','계좌','카드']},
  {k:'user', label:'구성원', hints:['구성원','user','이름','회원']}
];

function detectMapping(headers){
  const m = {};
  FIELD_KEYS.forEach(f=>{
    for(const h of headers){
      const hLower = String(h).toLowerCase();
      if(f.hints.some(hint=>hLower.includes(hint.toLowerCase()))){
        m[f.k] = h; break;
      }
    }
  });
  return m;
}

document.getElementById('excelFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const data = new Uint8Array(ev.target.result);
      const wb = XLSX.read(data, {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      // header row → object array
      const rows = XLSX.utils.sheet_to_json(ws, {defval:'', raw:false});
      if(!rows.length){ toast('엑셀에 데이터가 없습니다', 'err'); return; }
      excelRows = rows;
      excelHeaders = Object.keys(rows[0]);
      excelMapping = detectMapping(excelHeaders);
      excelDefaults = {type:'지출', user:DATA.meta.users[0], method:DATA.meta.methods[0], cat:DATA.meta.categories[0]};
      renderExcelPreview();
      document.getElementById('excelPreviewSection').style.display = 'block';
      document.getElementById('excelPreviewSection').scrollIntoView({behavior:'smooth'});
      toast(`${rows.length}개 행을 읽었습니다 — 컬럼을 확인하세요`, 'ok');
    }catch(err){
      toast('엑셀 읽기 실패: ' + err.message, 'err');
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

function renderExcelPreview(){
  document.getElementById('excelRowCount').textContent = `${excelRows.length}건`;

  // 컬럼 매핑 UI
  const mappingHTML = '<div class="excel-mapping">' + FIELD_KEYS.map(f=>`
    <div>
      <label>${escape(f.label)}</label>
      <select data-map-field="${f.k}">
        <option value="">— 사용 안 함 —</option>
        ${excelHeaders.map(h=>`<option value="${escape(h)}" ${excelMapping[f.k]===h?'selected':''}>${escape(h)}</option>`).join('')}
      </select>
    </div>
  `).join('') + '</div>';
  document.getElementById('excelMappingArea').innerHTML = mappingHTML;
  document.getElementById('excelMappingArea').querySelectorAll('[data-map-field]').forEach(s=>{
    s.addEventListener('change', e=>{
      excelMapping[e.target.dataset.mapField] = e.target.value;
      renderExcelTable();
    });
  });

  // 기본값 (매핑되지 않은 항목에 적용)
  document.getElementById('excelDefaultsArea').innerHTML = `
    <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--gold-deep);margin-bottom:10px">기본값 — 매핑되지 않은 항목에 자동 적용</div>
    <div class="excel-defaults">
      <div><label>유형</label><select data-def="type">
        <option value="지출">지출</option><option value="수입">수입</option><option value="이체">이체</option>
      </select></div>
      <div><label>구성원</label><select data-def="user">${DATA.meta.users.map(u=>`<option value="${u}">${escape(u)}</option>`).join('')}</select></div>
      <div><label>카테고리</label><select data-def="cat">${DATA.meta.categories.map(c=>`<option value="${c}">${escape(c)}</option>`).join('')}</select></div>
      <div><label>결제수단</label><select data-def="method">${DATA.meta.methods.map(m=>`<option value="${m}">${escape(m)}</option>`).join('')}</select></div>
    </div>`;
  document.querySelectorAll('[data-def]').forEach(s=>{
    s.value = excelDefaults[s.dataset.def] || '';
    s.addEventListener('change', e=>{
      excelDefaults[e.target.dataset.def] = e.target.value;
      renderExcelTable();
    });
  });

  renderExcelTable();
}

function parseExcelAmount(v){
  if(v==null) return 0;
  if(typeof v === 'number') return Math.abs(Math.round(v));
  const s = String(v).replace(/[^\d.-]/g,'');
  return Math.abs(Math.round(parseFloat(s) || 0));
}

function parseExcelDate(v){
  if(!v) return '';
  if(v instanceof Date){
    return v.getFullYear() + '-' + String(v.getMonth()+1).padStart(2,'0') + '-' + String(v.getDate()).padStart(2,'0');
  }
  const s = String(v).trim();
  // common formats: 2026-01-01, 2026/01/01, 26.01.01, 01/01/2026
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if(m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if(m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m = s.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if(m) return `20${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  return s;
}

function rowToTx(row){
  const get = k=> excelMapping[k] ? row[excelMapping[k]] : null;
  const t = {
    date: parseExcelDate(get('date')),
    amount: parseExcelAmount(get('amount')),
    type: String(get('type')||excelDefaults.type||'지출').trim(),
    user: String(get('user')||excelDefaults.user||DATA.meta.users[0]).trim(),
    cat: String(get('cat')||excelDefaults.cat||'기타').trim(),
    method: String(get('method')||excelDefaults.method||'기타').trim(),
    desc: String(get('desc')||'').trim(),
    memo: String(get('memo')||'').trim()
  };
  // type 정규화
  if(t.type && !['수입','지출','이체'].includes(t.type)){
    if(/입금|수입|급여|이자|배당/.test(t.type)) t.type = '수입';
    else if(/이체|trans|transfer/i.test(t.type)) t.type = '이체';
    else t.type = '지출';
  }
  return t;
}

function renderExcelTable(){
  const preview = excelRows.slice(0, 30).map(rowToTx);
  const hasMore = excelRows.length > 30;
  const valid = preview.filter(t=>t.date && t.amount>0).length;
  const total = preview.length;

  const html = `
    <div style="font-size:13px;color:var(--text-muted);margin:10px 0">미리보기 첫 ${total}건 (전체 ${excelRows.length}건) · 날짜·금액이 인식된 행: <b style="color:var(--inc)">${valid}건</b> / 비어있는 행: <b style="color:var(--exp)">${total-valid}건</b></div>
    <div class="excel-preview-wrap">
      <table class="excel-preview-table">
        <thead><tr><th>#</th><th>날짜</th><th>유형</th><th>금액</th><th>설명</th><th>카테고리</th><th>구성원</th><th>결제수단</th></tr></thead>
        <tbody>${preview.map((t,i)=>{
          const skip = !t.date || !t.amount;
          return `<tr class="${skip?'skip':''}">
            <td>${i+1}</td>
            <td>${escape(t.date||'-')}</td>
            <td>${escape(t.type)}</td>
            <td style="text-align:right;font-weight:600">${t.amount?fmtKRW(t.amount):'-'}</td>
            <td>${escape(t.desc)}</td>
            <td>${escape(t.cat)}</td>
            <td>${escape(t.user)}</td>
            <td>${escape(t.method)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    ${hasMore?`<div style="font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center">...외 ${excelRows.length-30}건 더</div>`:''}
  `;
  document.getElementById('excelPreviewArea').innerHTML = html;
}

document.getElementById('btnExcelAdd').addEventListener('click', ()=>{
  const all = excelRows.map(rowToTx).filter(t=>t.date && t.amount>0);
  if(!all.length){ toast('유효한 거래가 없습니다 (날짜와 금액 필수)', 'err'); return; }
  if(!confirm(`${all.length}건의 거래를 추가합니다. 계속할까요?`)) return;
  let nextId = DATA.nextId || (Math.max(0, ...DATA.transactions.map(x=>x.id||0)) + 1);
  all.forEach(t=>{ t.id = nextId++; DATA.transactions.push(t); });
  DATA.nextId = nextId;
  flashSync('dirty');
  saveData();
  rerenderAll();
  document.getElementById('excelPreviewSection').style.display = 'none';
  toast(`${all.length}건 추가 완료`, 'ok');
  showView('txlist');
});
document.getElementById('btnExcelCancel').addEventListener('click', ()=>{
  document.getElementById('excelPreviewSection').style.display = 'none';
  excelRows = []; excelHeaders = []; excelMapping = {}; excelDefaults = {};
});

// ---------- 스캔 이미지 ----------
let scanRotation = 0;
let scanZoom = 1;
let scanType = '지출';
let scanRecent = [];

document.getElementById('scanFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    document.getElementById('scanImg').src = ev.target.result;
    document.getElementById('scanSection').style.display = 'block';
    initScanForm();
    document.getElementById('scanSection').scrollIntoView({behavior:'smooth'});
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});
document.getElementById('btnScanClose').addEventListener('click', ()=>{
  document.getElementById('scanSection').style.display = 'none';
  scanRecent = [];
});
document.getElementById('btnScanReplace').addEventListener('click', ()=>document.getElementById('scanFile').click());
document.getElementById('scanRotate').addEventListener('click', ()=>{
  scanRotation = (scanRotation + 90) % 360;
  const img = document.getElementById('scanImg');
  img.classList.remove('rotated-90','rotated-180','rotated-270');
  if(scanRotation) img.classList.add('rotated-'+scanRotation);
});
document.getElementById('scanZoomIn').addEventListener('click', ()=>{
  scanZoom = Math.min(3, scanZoom + 0.2);
  document.getElementById('scanImg').style.transform = `scale(${scanZoom})${scanRotation?` rotate(${scanRotation}deg)`:''}`;
});
document.getElementById('scanZoomOut').addEventListener('click', ()=>{
  scanZoom = Math.max(0.5, scanZoom - 0.2);
  document.getElementById('scanImg').style.transform = `scale(${scanZoom})${scanRotation?` rotate(${scanRotation}deg)`:''}`;
});
document.querySelectorAll('#scanTypePicker .type-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    scanType = b.dataset.type;
    document.querySelectorAll('#scanTypePicker .type-btn').forEach(x=>x.classList.toggle('active', x===b));
  });
});
document.getElementById('sAmount').addEventListener('input', e=>{
  const v = e.target.value.replace(/[^\d]/g,'');
  e.target.value = v ? parseInt(v).toLocaleString() : '';
});

function initScanForm(){
  document.getElementById('sDate').value = new Date().toISOString().slice(0,10);
  document.getElementById('sAmount').value = '';
  document.getElementById('sUser').innerHTML = DATA.meta.users.map(u=>`<option value="${u}">${escape(u)}</option>`).join('');
  document.getElementById('sCat').innerHTML = DATA.meta.categories.map(c=>`<option value="${c}">${escape(c)}</option>`).join('');
  document.getElementById('sMethod').innerHTML = DATA.meta.methods.map(m=>`<option value="${m}">${escape(m)}</option>`).join('');
  document.getElementById('sDesc').value = '';
  document.getElementById('sMemo').value = '';
  scanType = '지출';
  document.querySelectorAll('#scanTypePicker .type-btn').forEach(b=>b.classList.toggle('active', b.dataset.type==='지출'));
  scanRecent = [];
  renderScanRecent();
}

document.getElementById('btnScanAdd').addEventListener('click', ()=>{
  const date = document.getElementById('sDate').value;
  const amount = parseInt(document.getElementById('sAmount').value.replace(/[^\d]/g,'')) || 0;
  if(!date){ toast('날짜를 입력하세요', 'err'); return; }
  if(amount<=0){ toast('금액을 입력하세요', 'err'); return; }
  const rec = {
    id: DATA.nextId || (Math.max(0, ...DATA.transactions.map(x=>x.id||0)) + 1),
    date, amount, type: scanType,
    user: document.getElementById('sUser').value,
    cat: document.getElementById('sCat').value,
    method: document.getElementById('sMethod').value,
    desc: document.getElementById('sDesc').value.trim(),
    memo: document.getElementById('sMemo').value.trim()
  };
  DATA.nextId = rec.id + 1;
  DATA.transactions.push(rec);
  scanRecent.unshift(rec);
  flashSync('dirty');
  saveData();
  rerenderAll();
  // form 초기화 (날짜·구성원·결제수단은 유지)
  document.getElementById('sAmount').value = '';
  document.getElementById('sDesc').value = '';
  document.getElementById('sMemo').value = '';
  document.getElementById('sAmount').focus();
  renderScanRecent();
  toast('추가됨 — 다음 거래 입력하세요', 'ok');
});

function renderScanRecent(){
  const cont = document.getElementById('scanRecentList');
  if(!scanRecent.length){ cont.innerHTML=''; return; }
  cont.innerHTML = `<div class="scan-recent-head">이 사진에서 추가한 거래 ${scanRecent.length}건</div>` +
    scanRecent.slice(0,8).map(r=>`<div class="scan-recent-item"><span>${escape(r.date.slice(5))} · ${escape(r.desc||'(설명없음)')}</span><b>${sign(r.type)}${fmtKRW(r.amount)}원</b></div>`).join('');
}


// ===== 📱 모바일 클라우드 동기화 =====
const PUBLIC_GIST_RAW = "https://gist.githubusercontent.com/yjjn2005/94caed101e1ce868e890fd839d041260/raw/yukim_ledger.json";

async function mobileSyncFromGist() {
  const btn = document.getElementById('mobileSyncBtn');
  const origText = btn ? btn.textContent : '';
  if(btn) { btn.disabled = true; btn.textContent = '동기화 중...'; }
  try {
    const resp = await fetch(PUBLIC_GIST_RAW + '?t=' + Date.now());
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    const remote = await resp.json();
    if(!remote || !remote.transactions) throw new Error('데이터 없음');
    DATA = remote;
    localStorage.setItem('yukim_ledger_v1', JSON.stringify(DATA));
    rerenderAll();
    toast('✅ 동기화 완료! ' + remote.transactions.length + '건', 'ok');
    if(btn) { btn.textContent = '✅ ' + remote.transactions.length + '건 완료'; }
    setTimeout(() => { if(btn) { btn.disabled=false; btn.textContent=origText; } }, 3000);
  } catch(e) {
    toast('❌ 동기화 실패: ' + e.message, 'err');
    if(btn) { btn.disabled=false; btn.textContent=origText; }
  }
}

async function autoSyncOnLoad() {
  try {
    const resp = await fetch(PUBLIC_GIST_RAW + '?t=' + Date.now());
    if(!resp.ok) return;
    const remote = await resp.json();
    if(!remote || !remote.transactions) return;
    const localTime = DATA.updatedAt || DATA.updated || '';
    const remoteTime = remote.updatedAt || remote.updated || '';
    if(remoteTime > localTime || remote.transactions.length > DATA.transactions.length) {
      DATA = remote;
      localStorage.setItem('yukim_ledger_v1', JSON.stringify(DATA));
      rerenderAll();
      toast('클라우드 동기화 완료 — ' + remote.transactions.length + '건', 'ok');
    }
  } catch(e) {}
}

// ---------- 초기 부트 ----------
buildSelectOptions();
bindFilters();
renderDash();
renderMonthly();
renderTxList();
renderCategory();
renderMember();
if(!getSyncConfig().enabled) flashSync('saved');
setTimeout(autoSyncOnLoad, 800);
