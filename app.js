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

const PUBLIC_GIST_ID = '94caed101e1ce868e890fd839d041260';

async function autoLoadFromPublicGist() {
  try {
    const cfg = getSyncConfig();
    if(cfg.enabled && cfg.gistId) return; // 이미 설정됨
    // 공개 Gist에서 자동 로드
    const resp = await fetch('https://api.github.com/gists/' + PUBLIC_GIST_ID, {
      headers: {'Accept': 'application/vnd.github+json'}
    });
    if(!resp.ok) return;
    const gist = await resp.json();
    const file = gist.files && gist.files['yukim_ledger.json'];
    if(!file) return;
    const rawResp = await fetch(file.raw_url);
    if(!rawResp.ok) return;
    const remoteData = await rawResp.json();
    if(!remoteData || !remoteData.transactions) return;
    // 로컬보다 원격이 최신인 경우 업데이트
    const localUpdated = DATA.updatedAt || DATA.updated || '2000-01-01';
    const remoteUpdated = remoteData.updatedAt || remoteData.updated || '2000-01-01';
    if(remoteUpdated > localUpdated || DATA.transactions.length < remoteData.transactions.length) {
      DATA = remoteData;
      saveData(true, {fromRemote: true});
      rerenderAll();
      toast('클라우드 데이터 동기화 완료 ✓', 'ok');
      console.log('[AutoSync] 공개 Gist에서 데이터 로드 완료');
    }
  } catch(e) { console.warn('[AutoSync] 오류:', e); }
}

// URL 파라미터로 쓰기 권한 설정 (PC용)
(function autoSyncFromURL(){
  try {
    const params = new URLSearchParams(window.location.search);
    const s = params.get('s') || params.get('sync');
    if(!s) return;
    const cfg = decodeSyncCode(s);
    if(!cfg || !cfg.token || !cfg.gistId) return;
    setSyncConfig({enabled:true, token:cfg.token, gistId:cfg.gistId, lastSync:null});
    window.history.replaceState({}, '', window.location.pathname);
    toast('동기화 설정 완료 ✓', 'ok');
  } catch(e) {}
})();


// ===== 모바일 동기화 (공개 Gist 직접 로드) =====
const PUBLIC_GIST_RAW = "https://gist.githubusercontent.com/yjjn2005/94caed101e1ce868e890fd839d041260/raw/yukim_ledger.json";

async function mobileSyncFromGist() {
  const btn = document.getElementById('mobileSyncBtn');
  if(btn) { btn.disabled = true; btn.textContent = '동기화 중...'; }
  try {
    // 캐시 방지
    const url = PUBLIC_GIST_RAW + '?t=' + Date.now();
    const resp = await fetch(url);
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    const remoteData = await resp.json();
    if(!remoteData || !remoteData.transactions) throw new Error('데이터 없음');
    const localCount = DATA.transactions.length;
    const remoteCount = remoteData.transactions.length;
    DATA = remoteData;
    localStorage.setItem('yukim_ledger_v1', JSON.stringify(DATA));
    rerenderAll();
    toast(`✅ 동기화 완료! ${remoteCount}건 로드됨`, 'ok');
    if(btn) { btn.textContent = `✅ ${remoteCount}건 동기화 완료`; }
    setTimeout(() => { if(btn) { btn.disabled = false; btn.textContent = '📱 클라우드 동기화'; } }, 3000);
  } catch(e) {
    toast('동기화 실패: ' + e.message, 'err');
    if(btn) { btn.disabled = false; btn.textContent = '📱 클라우드 동기화'; }
    console.error('[MobileSync]', e);
  }
}

// 페이지 로드 시 자동 동기화 (로컬 데이터가 없거나 오래된 경우)
async function autoSyncOnLoad() {
  try {
    const url = PUBLIC_GIST_RAW + '?t=' + Date.now();
    const resp = await fetch(url);
    if(!resp.ok) return;
    const remoteData = await resp.json();
    if(!remoteData || !remoteData.transactions) return;
    const localUpdated = DATA.updatedAt || DATA.updated || '2000-01-01';
    const remoteUpdated = remoteData.updatedAt || remoteData.updated || '2000-01-01';
    const remoteCount = remoteData.transactions.length;
    const localCount = DATA.transactions.length;
    if(remoteUpdated > localUpdated || remoteCount > localCount) {
      DATA = remoteData;
      localStorage.setItem('yukim_ledger_v1', JSON.stringify(DATA));
      rerenderAll();
      toast(`클라우드 동기화 완료 — ${remoteCount}건`, 'ok');
    }
  } catch(e) { /* 조용히 실패 */ }
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
setTimeout(autoSyncOnLoad, 500);
autoLoadFromPublicGist();
