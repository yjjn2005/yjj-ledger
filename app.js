/* BUILD:1782960137 - 동기화 완전 수정 */
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
const PUBLIC_GIST_ID = '94caed101e1ce868e890fd839d041260'; // 공용 동기화 Gist
const PUSH_DEBOUNCE_MS = 2000;
const PAGE_SIZE = 30;

function deepClone(o){return JSON.parse(JSON.stringify(o))}

let DATA = (()=>{
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const p = JSON.parse(raw);
      if(p && p.transactions){
        const localCnt = p.transactions.length;
        const initCnt = window.INITIAL_DATA.transactions.length;
        const localTime = p.updatedAt || p.updated || '';
        const initTime = window.INITIAL_DATA.updatedAt || window.INITIAL_DATA.updated || '';
        // localStorage 데이터가 INITIAL_DATA보다 건수가 많거나 최신이면 localStorage 사용
        if(localCnt >= initCnt || localTime > initTime){
          return p;
        }
        // INITIAL_DATA가 더 최신/많으면 localStorage 업데이트 후 INITIAL_DATA 사용
        console.log('[BOOT] localStorage('+localCnt+'건) < INITIAL_DATA('+initCnt+'건) → INITIAL_DATA 사용');
        localStorage.setItem(STORAGE_KEY, JSON.stringify(window.INITIAL_DATA));
        return deepClone(window.INITIAL_DATA);
      }
    }
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
    if(cfg.token) schedulePush(); // token만 있으면 (enabled 체크 없이) Public Gist 업데이트
    else if(cfg.enabled && cfg.gistId) schedulePush();
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
  if(v==='balances') renderViewBalances();
  if(v==='cardspend') renderViewCardSpend();
  if(v==='dividend') renderViewDividend();
  if(v==='golf') renderViewGolf();
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
  try{ renderBalances(); }catch(_){}
  renderViewBalances();
  renderViewCardSpend();
  renderViewDividend();
  renderViewGolf();
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
  // Public Gist 자동 업데이트 (모바일 자동 동기화 소스)
  // getSyncConfig에 token이 있으면 Public Gist도 동시 업데이트
  if(cfg.token) {
    try {
      await updateGist(cfg.token, PUBLIC_GIST_ID, DATA);
    } catch(e) {
      console.warn('[publicGist] 업데이트 실패:', e.message);
    }
  }
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

// ===== 다중 탭/기기 덮어쓰기 방지 안전장치 =====
// 다른 탭이 localStorage를 변경하면 즉시 이 탭의 메모리에 반영 → 옛 데이터로 덮어쓰기 방지
window.addEventListener('storage', function(e){
  if(e.key===STORAGE_KEY && e.newValue){
    try{
      var p = JSON.parse(e.newValue);
      if(p && p.transactions && (p.updatedAt||'') !== (DATA.updatedAt||'')){
        DATA = p; rerenderAll();
      }
    }catch(_){}
  }
});
// 화면이 다시 보이면: 로컬 최신본 재적재 + (동기화 시) 클라우드 최신본 확인
document.addEventListener('visibilitychange', function(){
  if(document.visibilityState!=='visible') return;
  // 앱 전환 후 복귀시 클라우드 동기화 (모바일에서 다른 앱 갔다 돌아올 때)
  setTimeout(autoSyncOnLoad, 200);
  try{
    var raw = localStorage.getItem(STORAGE_KEY);
    if(raw){ var p = JSON.parse(raw); if(p && p.transactions && (p.updatedAt||'') > (DATA.updatedAt||'')){ DATA = p; rerenderAll(); } }
  }catch(_){}
  try{ var cfg = getSyncConfig(); if(cfg.enabled) doPull(true); }catch(_){}
});
// 저장 직전, 다른 탭이 더 최신이면 병합 대신 최신 반영(오래된 메모리로 밀어내기 방지)
var __origSaveData = saveData;
saveData = function(silent, opts){
  opts = opts || {};
  if(!opts.fromRemote){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(raw){
        var cur = JSON.parse(raw);
        if(cur && cur.updatedAt && (cur.updatedAt > (DATA.updatedAt||'')) && (cur.transactions && cur.transactions.length > DATA.transactions.length)){
          // 다른 탭이 더 많은/최신 데이터를 갖고 있으면 그걸 채택 후 이어서 진행
          DATA = cur; rerenderAll();
        }
      }
    }catch(_){}
  }
  return __origSaveData(silent, opts);
};

// ===== 통장 잔고 & 빠른 분석 (대시보드) =====
function defaultBalances(){
  return {
    '유재진|신한은행 개인(이체)':8647391,
    '유재진|신한은행 사업자(이체)':37316302,
    '김희연|신한은행 개인(이체)':68058866,
    '현금|현금':0
  };
}
function getBalances(){ if(!DATA.balances){ DATA.balances = defaultBalances(); } return DATA.balances; }
function setBalances(b){ DATA.balances = b; saveData(true); }
function isBankMethod(m){ m=m||''; return m.indexOf('은행')>=0 || m==='현금'; }
function canonMethod(m){
  m=m||'-';
  if(m==='신한은행(이체)'||m==='신한은행개인(이체)') return '신한은행 개인(이체)';
  if(m==='농협은행(이체)') return '농협은행 개인(이체)';
  return m;
}
function accountGroups(){
  var g={};
  DATA.transactions.forEach(function(t){
    if(!isBankMethod(t.method)) return;
    var cm=canonMethod(t.method);
    var key=(t.user||'-')+'|'+cm;
    if(!g[key]) g[key]={user:t.user||'-',method:cm,inc:0,exp:0,trf:0};
    if(t.type==='수입') g[key].inc+=t.amount;
    else if(t.type==='지출') g[key].exp+=t.amount;
    else g[key].trf+=t.amount;
  });
  return g;
}
function renderBalances(){
  var el=document.getElementById('dashBalances'); if(!el) return;
  var g=accountGroups(); var bal=getBalances();
  Object.keys(bal).forEach(function(k){ if(!g[k]){ var p=k.split('|'); g[k]={user:p[0],method:p[1],inc:0,exp:0,trf:0}; } });
  var keys=Object.keys(g).sort();
  el.innerHTML = keys.map(function(k){
    var a=g[k]; var net=a.inc-a.exp; var real=bal[k];
    return '<div class="bal-card">'
      +'<div class="bal-acct">'+escape(a.user)+'</div>'
      +'<div class="bal-method">'+escape(a.method)+'</div>'
      +'<div class="bal-real">실잔액 <b>'+(real!=null?fmtKRW(real)+'원':'-')+'</b></div>'
      +'<div class="bal-net '+(net>=0?'pos':'neg')+'">순증감 '+(net>=0?'+':'')+fmtKRW(net)+'원</div>'
      +'</div>';
  }).join('') || '<div class="empty">은행/현금 거래가 없습니다</div>';
}
// ======== 4개 전용 뷰 렌더 ========
﻿// ======== 4개 전용 뷰 렌더 (월별 그리드) ========

function _mHead(months){
  return months.map(function(m){return "<th class='num'>"+m.slice(5)+"월</th>";}).join("");
}

function renderViewBalances(){
  var el=document.getElementById("viewBalancesBody"); if(!el) return;
  var monthly={};
  DATA.transactions.forEach(function(t){
    if(t.type==="이체") return;
    var u=t.user||""; var me=t.method||"";
    var acct=me.replace(/[(（][^)）]*[)）]/g,"").trim();
    var key=u+"|"+acct;
    var mo=(t.date||"").slice(0,7); if(!mo) return;
    monthly[key]=monthly[key]||{};
    monthly[key][mo]=(monthly[key][mo]||0)+(t.type==="수입"?t.amount:-t.amount);
  });
  var allMonths=Object.keys(DATA.transactions.reduce(function(s,t){var m=(t.date||"").slice(0,7);if(m)s[m]=1;return s;},{})).sort();
  var h="";
  h+=_balSection("👤 유재진 개인",[
    {label:"신한은행(개인)", key:"유재진|신한은행 개인"},
    {label:"농협은행(개인)", key:"유재진|농협은행 개인"}
  ], monthly, allMonths);
  h+=_balSection("🏢 사업자 (신한)",[
    {label:"신한은행(사업자)", key:"유재진|신한은행 사업자"}
  ], monthly, allMonths);
  h+=_balSection("👤 김희연",[
    {label:"신한은행", key:"김희연|신한은행 개인"}
  ], monthly, allMonths);
  el.innerHTML=h||"<div class='empty'>거래 데이터가 없습니다</div>";
}

function _balSection(title, accts, monthly, months){
  var h="<div class='an-group'><div class='an-group-title'>"+escape(title)+"</div>";
  h+="<div style='overflow-x:auto'><table class='an-table'><thead><tr><th>계좌</th>"+_mHead(months)+"<th class='num'>누계</th></tr></thead><tbody>";
  accts.forEach(function(a){
    var cum=0;
    h+="<tr><td>"+escape(a.label)+"</td>";
    months.forEach(function(mo){
      var v=(monthly[a.key]&&monthly[a.key][mo])||0; cum+=v;
      h+="<td class='num "+(v>=0?"pos":"neg")+"'>"+(v?((v>=0?"+":"")+fmtKRW(v)):"-")+"</td>";
    });
    h+="<td class='num tot "+(cum>=0?"pos":"neg")+"'>"+(cum>=0?"+":"")+fmtKRW(cum)+"</td></tr>";
  });
  h+="</tbody></table></div></div>";
  return h;
}

function renderViewCardSpend(){
  var el=document.getElementById("viewCardSpendBody"); if(!el) return;
  var monthly={};
  DATA.transactions.forEach(function(t){
    if(t.type!=="지출") return;
    var me=t.method||"";
    if(me.indexOf("카드")<0&&me.indexOf("Card")<0) return;
    var u=t.user||""; var key=u+"|"+me;
    var mo=(t.date||"").slice(0,7); if(!mo) return;
    monthly[key]=monthly[key]||{_tot:0};
    monthly[key][mo]=(monthly[key][mo]||0)+t.amount;
    monthly[key]._tot+=t.amount;
  });
  var allMonths=Object.keys(Object.keys(monthly).reduce(function(s,k){Object.keys(monthly[k]).forEach(function(m){if(m!="_tot")s[m]=1;});return s;},{})).sort();
  var kyKeys=Object.keys(monthly).filter(function(k){return k.startsWith("김희연|");}).sort();
  var yjKeys=Object.keys(monthly).filter(function(k){return k.startsWith("유재진|");}).sort();
  var h="";
  if(kyKeys.length) h+=_cardSection("👤 김희연", kyKeys, monthly, allMonths);
  if(yjKeys.length) h+=_cardSection("👤 유재진", yjKeys, monthly, allMonths);
  el.innerHTML=h||"<div class='empty'>카드 지출 내역이 없습니다</div>";
}

function _cardSection(title, keys, monthly, months){
  var h="<div class='an-group'><div class='an-group-title'>"+escape(title)+"</div>";
  h+="<div style='overflow-x:auto'><table class='an-table'><thead><tr><th>카드</th>"+_mHead(months)+"<th class='num'>합계</th></tr></thead><tbody>";
  var mSums={};
  var grand=0;
  keys.forEach(function(k){
    var label=k.split("|")[1];
    var tot=monthly[k]._tot||0; grand+=tot;
    h+="<tr><td style='font-size:.87em'>"+escape(label)+"</td>";
    months.forEach(function(mo){
      var v=monthly[k][mo]||0; mSums[mo]=(mSums[mo]||0)+v;
      h+="<td class='num'>"+(v?fmtKRW(v):"-")+"</td>";
    });
    h+="<td class='num tot'>"+fmtKRW(tot)+"</td></tr>";
  });
  h+="<tr class='subtotal'><td><b>소계</b></td>";
  months.forEach(function(mo){h+="<td class='num'><b>"+(mSums[mo]?fmtKRW(mSums[mo]):"-")+"</b></td>";});
  h+="<td class='num tot'><b>"+fmtKRW(grand)+"</b></td></tr>";
  h+="</tbody></table></div></div>";
  return h;
}

function renderViewDividend(){
  var el=document.getElementById("viewDividendBody"); if(!el) return;
  var monthly={};
  DATA.transactions.forEach(function(t){
    var c=t.cat||"",d=t.desc||"";
    if(c.indexOf("분배")<0&&c.indexOf("배당")<0&&d.indexOf("배당")<0&&d.indexOf("분배")<0) return;
    var name=d.replace(/[0-9]+\./,"").replace(/(배당금|배당|분배금|분배)/g,"").replace(/[(（].*$/,"").trim();
    if(!name) name=t.user||"(미상)";
    var mo=(t.date||"").slice(0,7); if(!mo) return;
    monthly[name]=monthly[name]||{_tot:0};
    monthly[name][mo]=(monthly[name][mo]||0)+t.amount;
    monthly[name]._tot+=t.amount;
  });
  var names=Object.keys(monthly).sort(function(a,b){return monthly[b]._tot-monthly[a]._tot;});
  if(!names.length){el.innerHTML="<div class='empty'>배당/분배 내역이 없습니다</div>";return;}
  var allMonths=Object.keys(names.reduce(function(s,n){Object.keys(monthly[n]).forEach(function(m){if(m!="_tot")s[m]=1;});return s;},{})).sort();
  var h="<div style='overflow-x:auto'><table class='an-table'><thead><tr><th>대상</th>"+_mHead(allMonths)+"<th class='num'>합계</th></tr></thead><tbody>";
  var mSums={}; var grand=0;
  names.forEach(function(n){
    var tot=monthly[n]._tot||0; grand+=tot;
    h+="<tr><td>"+escape(n)+"</td>";
    allMonths.forEach(function(mo){var v=monthly[n][mo]||0;mSums[mo]=(mSums[mo]||0)+v;h+="<td class='num'>"+(v?fmtKRW(v):"-")+"</td>";});
    h+="<td class='num tot'>"+fmtKRW(tot)+"</td></tr>";
  });
  h+="<tr class='subtotal'><td><b>합계</b></td>";
  allMonths.forEach(function(mo){h+="<td class='num'><b>"+(mSums[mo]?fmtKRW(mSums[mo]):"-")+"</b></td>";});
  h+="<td class='num tot'><b>"+fmtKRW(grand)+"</b></td></tr>";
  h+="</tbody></table></div>";
  el.innerHTML=h;
}

function renderViewGolf(){
  var el=document.getElementById("viewGolfBody"); if(!el) return;
  var monthly={};
  DATA.transactions.forEach(function(t){
    var s=(t.cat||"")+(t.desc||"");
    if(s.indexOf("골프")<0&&s.indexOf("캐디")<0) return;
    var u=t.user||"(미상)";
    var mo=(t.date||"").slice(0,7); if(!mo) return;
    var amt=(t.type==="수입"?-t.amount:t.amount);
    monthly[u]=monthly[u]||{_tot:0};
    monthly[u][mo]=(monthly[u][mo]||0)+amt;
    monthly[u]._tot+=amt;
  });
  var users=Object.keys(monthly).sort(function(a,b){return monthly[b]._tot-monthly[a]._tot;});
  if(!users.length){el.innerHTML="<div class='empty'>골프 관련 내역이 없습니다</div>";return;}
  var allMonths=Object.keys(users.reduce(function(s,u){Object.keys(monthly[u]).forEach(function(m){if(m!="_tot")s[m]=1;});return s;},{})).sort();
  var grand=users.reduce(function(x,u){return x+monthly[u]._tot;},0);
  var h="<div class='an-sum' style='margin-bottom:14px'>골프 총액 <b>"+fmtKRW(grand)+"원</b></div>";
  h+="<div style='overflow-x:auto'><table class='an-table'><thead><tr><th>구성원</th>"+_mHead(allMonths)+"<th class='num'>합계</th></tr></thead><tbody>";
  var mSums={};
  users.forEach(function(u){
    var tot=monthly[u]._tot||0;
    h+="<tr><td>"+escape(u)+"</td>";
    allMonths.forEach(function(mo){var v=monthly[u][mo]||0;mSums[mo]=(mSums[mo]||0)+v;h+="<td class='num'>"+(v?fmtKRW(v):"-")+"</td>";});
    h+="<td class='num tot'>"+fmtKRW(tot)+"</td></tr>";
  });
  h+="<tr class='subtotal'><td><b>합계</b></td>";
  allMonths.forEach(function(mo){h+="<td class='num'><b>"+(mSums[mo]?fmtKRW(mSums[mo]):"-")+"</b></td>";});
  h+="<td class='num tot'><b>"+fmtKRW(grand)+"</b></td></tr>";
  h+="</tbody></table></div>";
  el.innerHTML=h;
}


function openAnalysis(title, html){
  var t=document.getElementById('analysisTitle'), b=document.getElementById('analysisBody'), m=document.getElementById('analysisModal');
  if(!m) return; t.textContent=title; b.innerHTML=html; m.classList.add('active');
}
function closeAnalysis(){ var m=document.getElementById('analysisModal'); if(m) m.classList.remove('active'); }
function analysisCardSpend(){
  var cards={};
  DATA.transactions.forEach(function(t){
    if(t.type!=='지출') return;
    if(String(t.method||'').indexOf('카드')<0) return;
    var m=(t.date||'').slice(0,7);
    cards[t.method]=cards[t.method]||{_tot:0}; cards[t.method][m]=(cards[t.method][m]||0)+t.amount; cards[t.method]._tot+=t.amount;
  });
  var names=Object.keys(cards).sort();
  if(!names.length) return openAnalysis('💳 카드별 월 지출 합계','<div class="empty">카드 지출 내역이 없습니다</div>');
  var mset={}; names.forEach(function(n){Object.keys(cards[n]).forEach(function(m){if(m!=='_tot')mset[m]=1;});});
  var mkeys=Object.keys(mset).sort();
  var h='<table class="an-table"><thead><tr><th>카드</th>'+mkeys.map(function(m){return '<th class="num">'+m.slice(2)+'</th>';}).join('')+'<th class="num">합계</th></tr></thead><tbody>';
  names.forEach(function(n){ h+='<tr><td>'+escape(n)+'</td>'+mkeys.map(function(m){return '<td class="num">'+(cards[n][m]?fmtKRW(cards[n][m]):'-')+'</td>';}).join('')+'<td class="num tot">'+fmtKRW(cards[n]._tot)+'</td></tr>'; });
  var grand=names.reduce(function(x,n){return x+cards[n]._tot;},0);
  h+='</tbody><tfoot><tr><td>전체</td>'+mkeys.map(function(m){var s=names.reduce(function(x,n){return x+(cards[n][m]||0);},0);return '<td class="num">'+fmtKRW(s)+'</td>';}).join('')+'<td class="num tot">'+fmtKRW(grand)+'</td></tr></tfoot></table>';
  openAnalysis('💳 카드별 월 지출 합계', h);
}
function analysisDividend(){
  var per={};
  DATA.transactions.forEach(function(t){
    var c=t.cat||'', d=t.desc||'';
    if(!(c.indexOf('분배')>=0||c.indexOf('배당')>=0||d.indexOf('배당')>=0||d.indexOf('분배')>=0)) return;
    var name=d.replace(/\d+\./,'').replace(/(배당금|배당|분배금|분배)/g,'').replace(/\(.*$/,'').trim();
    if(!name) name=d||'(미상)';
    per[name]=per[name]||{cnt:0,amt:0,dates:[]};
    per[name].cnt++; per[name].amt+=t.amount; per[name].dates.push(t.date);
  });
  var names=Object.keys(per).sort(function(a,b){return per[b].amt-per[a].amt;});
  if(!names.length) return openAnalysis('💰 인별 배당금 지급현황','<div class="empty">배당/분배 내역이 없습니다</div>');
  var tot=names.reduce(function(x,n){return x+per[n].amt;},0);
  var tc=names.reduce(function(x,n){return x+per[n].cnt;},0);
  var h='<table class="an-table"><thead><tr><th>대상</th><th class="num">건수</th><th class="num">지급액</th><th>최근일</th></tr></thead><tbody>';
  names.forEach(function(n){ var p=per[n]; h+='<tr><td>'+escape(n)+'</td><td class="num">'+p.cnt+'</td><td class="num">'+fmtKRW(p.amt)+'원</td><td>'+escape(p.dates.sort().slice(-1)[0]||'')+'</td></tr>'; });
  h+='</tbody><tfoot><tr><td>합계</td><td class="num">'+tc+'</td><td class="num tot">'+fmtKRW(tot)+'원</td><td></td></tr></tfoot></table>';
  openAnalysis('💰 인별 배당금 지급현황', h);
}
function analysisGolf(){
  var rows=DATA.transactions.filter(function(t){ var s=(t.cat||'')+(t.desc||''); return s.indexOf('골프')>=0||s.indexOf('캐디')>=0; });
  if(!rows.length) return openAnalysis('⛳ 골프 관련 비용','<div class="empty">골프 관련 내역이 없습니다</div>');
  rows.sort(function(a,b){return (a.date<b.date)?-1:1;});
  var tot=rows.reduce(function(x,t){return x+(t.type==='수입'?-t.amount:t.amount);},0);
  var h='<div class="an-sum">골프 관련 총액 <b>'+fmtKRW(tot)+'원</b> · '+rows.length+'건</div>';
  h+='<table class="an-table"><thead><tr><th>날짜</th><th>내용</th><th>구성원</th><th>결제</th><th class="num">금액</th></tr></thead><tbody>';
  rows.forEach(function(t){ h+='<tr><td>'+escape(t.date)+'</td><td>'+escape(t.desc||'')+'</td><td>'+escape(t.user||'')+'</td><td>'+escape(t.method||'')+'</td><td class="num">'+fmtKRW(t.amount)+'</td></tr>'; });
  h+='</tbody></table>';
  openAnalysis('⛳ 골프 관련 비용', h);
}
function editBalancesModal(){
  var g=accountGroups(); var bal=getBalances();
  Object.keys(bal).forEach(function(k){ if(!g[k]){var p=k.split('|');g[k]={user:p[0],method:p[1]};} });
  var keys=Object.keys(g).sort();
  var h='<div class="an-note">각 통장의 현재 실제 잔액을 입력하세요. (기기 간 동기화됩니다)</div><table class="an-table"><thead><tr><th>통장</th><th class="num">실잔액(원)</th></tr></thead><tbody>';
  keys.forEach(function(k){ h+='<tr><td>'+escape(g[k].user)+' · '+escape(g[k].method)+'</td><td class="num"><input type="number" class="bal-input" data-key="'+escape(k)+'" value="'+(bal[k]!=null?bal[k]:'')+'"></td></tr>'; });
  h+='</tbody></table><div style="margin-top:14px;text-align:right"><button class="btn btn-primary" id="balSave">저장</button></div>';
  openAnalysis('통장 실잔액 수정', h);
  var sv=document.getElementById('balSave');
  if(sv) sv.addEventListener('click', function(){
    var b=getBalances();
    document.querySelectorAll('.bal-input').forEach(function(inp){ var v=String(inp.value).trim(); if(v==='') delete b[inp.dataset.key]; else b[inp.dataset.key]=parseInt(v.replace(/[^\d-]/g,''))||0; });
    setBalances(b); closeAnalysis(); renderBalances(); toast('실잔액 저장됨','ok');
  });
}
function analysisBalances(){
  var g=accountGroups(); var bal=getBalances();
  Object.keys(bal).forEach(function(k){ if(!g[k]){var p=k.split('|');g[k]={user:p[0],method:p[1],inc:0,exp:0,trf:0};} });
  var keys=Object.keys(g).sort();
  var h='<div class="an-note">각 통장의 월말 잔고(실잔액)를 입력하면 저장·기기간 동기화됩니다. 순증감은 기록된 수입-지출 합계입니다.</div>';
  h+='<table class="an-table"><thead><tr><th>통장</th><th class="num">월말 잔고(원)</th><th class="num">순증감</th></tr></thead><tbody>';
  keys.forEach(function(k){ var a=g[k]; var net=a.inc-a.exp; h+='<tr><td>'+escape(a.user)+' · '+escape(a.method)+'</td><td class="num"><input type="number" class="bal-input" data-key="'+escape(k)+'" value="'+(bal[k]!=null?bal[k]:'')+'"></td><td class="num '+(net>=0?'pos':'neg')+'">'+(net>=0?'+':'')+fmtKRW(net)+'</td></tr>'; });
  h+='</tbody></table><div style="margin-top:14px;text-align:right"><button class="btn btn-primary" id="balSave">저장</button></div>';
  openAnalysis('🏦 통장별 월말 잔고', h);
  var sv=document.getElementById('balSave');
  if(sv) sv.addEventListener('click', function(){
    var b=getBalances();
    document.querySelectorAll('.bal-input').forEach(function(inp){ var v=String(inp.value).trim(); if(v==='') delete b[inp.dataset.key]; else b[inp.dataset.key]=parseInt(v.replace(/[^\d-]/g,''))||0; });
    setBalances(b); toast('월말 잔고 저장됨','ok'); analysisBalances();
  });
}

function analysisMember(){
  var per={};
  DATA.transactions.forEach(function(t){
    if(t.type!=='지출') return;
    var u=t.user||'(미상)';
    per[u]=per[u]||{cnt:0,amt:0};
    per[u].cnt++; per[u].amt+=t.amount;
  });
  var names=Object.keys(per).sort(function(a,b){return per[b].amt-per[a].amt;});
  if(!names.length) return openAnalysis('👥 구성원별 지출 현황','<div class="empty">지출 내역이 없습니다</div>');
  var tot=names.reduce(function(x,n){return x+per[n].amt;},0);
  var h='<table class="an-table"><thead><tr><th>구성원</th><th class="num">건수</th><th class="num">지출액</th><th class="num">비율</th></tr></thead><tbody>';
  names.forEach(function(n){
    var pct=tot>0?Math.round(per[n].amt/tot*100):0;
    h+='<tr><td>'+escape(n)+'</td><td class="num">'+per[n].cnt+'</td><td class="num">'+fmtKRW(per[n].amt)+'원</td><td class="num">'+pct+'%</td></tr>';
  });
  h+='</tbody><tfoot><tr><td>합계</td><td class="num">'+names.reduce(function(x,n){return x+per[n].cnt;},0)+'</td><td class="num tot">'+fmtKRW(tot)+'원</td><td class="num">100%</td></tr></tfoot></table>';
  openAnalysis('👥 구성원별 지출 현황', h);
}

function analysisCategory(){
  var per={};
  DATA.transactions.forEach(function(t){
    if(t.type!=='지출') return;
    var c=t.cat||'(미분류)';
    per[c]=per[c]||{cnt:0,amt:0};
    per[c].cnt++; per[c].amt+=t.amount;
  });
  var names=Object.keys(per).sort(function(a,b){return per[b].amt-per[a].amt;});
  if(!names.length) return openAnalysis('🏷 카테고리별 지출 분석','<div class="empty">지출 내역이 없습니다</div>');
  var tot=names.reduce(function(x,n){return x+per[n].amt;},0);
  var h='<table class="an-table"><thead><tr><th>카테고리</th><th class="num">건수</th><th class="num">지출액</th><th class="num">비율</th></tr></thead><tbody>';
  names.forEach(function(n){
    var pct=tot>0?Math.round(per[n].amt/tot*100):0;
    h+='<tr><td>'+escape(n)+'</td><td class="num">'+per[n].cnt+'</td><td class="num">'+fmtKRW(per[n].amt)+'원</td><td class="num">'+pct+'%</td></tr>';
  });
  h+='</tbody><tfoot><tr><td>합계</td><td class="num">'+names.reduce(function(x,n){return x+per[n].cnt;},0)+'</td><td class="num tot">'+fmtKRW(tot)+'원</td><td class="num">100%</td></tr></tfoot></table>';
  openAnalysis('🏷 카테고리별 지출 분석', h);
}

function analysisPayMethod(){
  var per={};
  DATA.transactions.forEach(function(t){
    if(t.type!=='지출') return;
    var m=t.method||'(미상)';
    per[m]=per[m]||{cnt:0,amt:0};
    per[m].cnt++; per[m].amt+=t.amount;
  });
  var names=Object.keys(per).sort(function(a,b){return per[b].amt-per[a].amt;});
  if(!names.length) return openAnalysis('💵 결제수단별 현황','<div class="empty">지출 내역이 없습니다</div>');
  var tot=names.reduce(function(x,n){return x+per[n].amt;},0);
  var h='<table class="an-table"><thead><tr><th>결제수단</th><th class="num">건수</th><th class="num">지출액</th><th class="num">비율</th></tr></thead><tbody>';
  names.forEach(function(n){
    var pct=tot>0?Math.round(per[n].amt/tot*100):0;
    h+='<tr><td>'+escape(n)+'</td><td class="num">'+per[n].cnt+'</td><td class="num">'+fmtKRW(per[n].amt)+'원</td><td class="num">'+pct+'%</td></tr>';
  });
  h+='</tbody><tfoot><tr><td>합계</td><td class="num">'+names.reduce(function(x,n){return x+per[n].cnt;},0)+'</td><td class="num tot">'+fmtKRW(tot)+'원</td><td class="num">100%</td></tr></tfoot></table>';
  openAnalysis('💵 결제수단별 현황', h);
}

function analysisMonthlyNet(){
  var per={};
  DATA.transactions.forEach(function(t){
    var m=(t.date||'').slice(0,7); if(!m) return;
    per[m]=per[m]||{inc:0,exp:0};
    if(t.type==='수입') per[m].inc+=t.amount;
    else if(t.type==='지출') per[m].exp+=t.amount;
  });
  var months=Object.keys(per).sort();
  if(!months.length) return openAnalysis('📊 월별 순익 추이','<div class="empty">거래 내역이 없습니다</div>');
  var h='<table class="an-table"><thead><tr><th>월</th><th class="num">수입</th><th class="num">지출</th><th class="num">순익</th></tr></thead><tbody>';
  var totInc=0,totExp=0;
  months.forEach(function(m){
    var p=per[m]; var net=p.inc-p.exp; totInc+=p.inc; totExp+=p.exp;
    h+='<tr><td>'+m+'</td><td class="num pos">'+fmtKRW(p.inc)+'</td><td class="num neg">'+fmtKRW(p.exp)+'</td><td class="num '+(net>=0?'pos':'neg')+'">'+(net>=0?'+':'')+fmtKRW(net)+'</td></tr>';
  });
  var totNet=totInc-totExp;
  h+='</tbody><tfoot><tr><td>합계</td><td class="num pos tot">'+fmtKRW(totInc)+'</td><td class="num neg tot">'+fmtKRW(totExp)+'</td><td class="num '+(totNet>=0?'pos':'neg')+' tot">'+(totNet>=0?'+':'')+fmtKRW(totNet)+'</td></tr></tfoot></table>';
  openAnalysis('📊 월별 순익 추이', h);
}(function(){
  function on(id,fn){ var e=document.getElementById(id); if(e) e.addEventListener('click',fn); }
  on('btnEditBalances',editBalancesModal);
  on('btnEditBalancesV',editBalancesModal);
  on('analysisClose',closeAnalysis);
  var m=document.getElementById('analysisModal');
  if(m) m.addEventListener('click',function(e){ if(e.target===m) closeAnalysis(); });
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
    scanRotation = 0; scanZoom = 1;
    const img = document.getElementById('scanImg');
    img.src = ev.target.result;
    img.classList.remove('rotated-90','rotated-180','rotated-270');
    img.style.transform = 'scale(1) rotate(0deg)';
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
function applyScanTransform(){
  const img = document.getElementById('scanImg');
  img.classList.remove('rotated-90','rotated-180','rotated-270');
  img.style.transformOrigin = 'center center';
  img.style.transform = `scale(${scanZoom}) rotate(${scanRotation}deg)`;
}
document.getElementById('scanRotate').addEventListener('click', ()=>{
  scanRotation = (scanRotation + 90) % 360;
  applyScanTransform();
});
document.getElementById('scanZoomIn').addEventListener('click', ()=>{
  scanZoom = Math.min(3, scanZoom + 0.2);
  applyScanTransform();
});
document.getElementById('scanZoomOut').addEventListener('click', ()=>{
  scanZoom = Math.max(0.5, scanZoom - 0.2);
  applyScanTransform();
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
    const resp = await fetch(PUBLIC_GIST_RAW + '?nocache=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
    });
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
    // 캐시버스터 + no-cache 헤더로 항상 최신 데이터 요청
    const resp = await fetch(PUBLIC_GIST_RAW + '?nocache=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
    });
    if(!resp.ok) return;
    const remote = await resp.json();
    if(!remote || !remote.transactions) return;

    // localStorage에 실제 저장된 데이터가 있는지 확인
    const hasLocalSaved = !!localStorage.getItem('yukim_ledger_v1');
    const localTxCount = DATA.transactions ? DATA.transactions.length : 0;
    const remoteTxCount = remote.transactions.length;

    // 로컬 저장 데이터가 없으면 (모바일 첫 접속, INITIAL_DATA만 있는 경우) 무조건 Gist 사용
    if(!hasLocalSaved) {
      DATA = remote;
      localStorage.setItem('yukim_ledger_v1', JSON.stringify(DATA));
      rerenderAll();
      toast('☁ 클라우드 데이터 로드 완료 — ' + remoteTxCount + '건', 'ok');
      return;
    }

    // 로컬 저장 데이터가 있으면 updatedAt 비교 (정확한 ISO 문자열 비교)
    const localRaw = localStorage.getItem('yukim_ledger_v1');
    const localSaved = localRaw ? JSON.parse(localRaw) : null;
    const localTime = localSaved ? (localSaved.updatedAt || localSaved.updated || '') : '';
    const remoteTime = remote.updatedAt || remote.updated || '';

    const shouldUpdate = (remoteTime && localTime && remoteTime > localTime) ||
                         (!localTime && remoteTxCount > 0) ||
                         (remoteTxCount > localTxCount + 5); // 원격이 5건 이상 많으면 업데이트

    if(shouldUpdate) {
      DATA = remote;
      localStorage.setItem('yukim_ledger_v1', JSON.stringify(DATA));
      rerenderAll();
      toast('☁ 동기화 완료 — ' + remoteTxCount + '건', 'ok');
    }
  } catch(e) {
    // 동기화 실패 시 조용히 무시 (로컬 데이터 사용)
    console.warn('[autoSync] 실패:', e.message);
  }
}

// ===== 최신 INITIAL_DATA 강제 복원 함수 =====
function resetToLatest(){
  if(!confirm('localStorage를 초기화하고 최신 데이터(' + window.INITIAL_DATA.transactions.length + '건)로 복원합니까?\n\n⚠️ 앱에서 직접 추가/수정한 내용은 사라집니다.')) return;
  localStorage.removeItem(STORAGE_KEY);
  DATA = deepClone(window.INITIAL_DATA);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
  rerenderAll();
  toast('✅ 최신 데이터(' + DATA.transactions.length + '건)로 복원 완료!', 'ok');
}

// ---------- 초기 부트 ----------
buildSelectOptions();
bindFilters();
renderDash();
renderMonthly();
renderTxList();
renderCategory();
renderMember();
try{ renderBalances(); }catch(_){}
renderViewBalances();
renderViewCardSpend();
renderViewDividend();
renderViewGolf();
if(!getSyncConfig().enabled) flashSync('saved');
// 앱 시작 즉시 클라우드 동기화 (300ms 후 - DOM 안정화 대기)
setTimeout(autoSyncOnLoad, 300);
// 5분마다 자동 백그라운드 동기화 (탭을 열어두면 자동 최신화)
setInterval(autoSyncOnLoad, 5 * 60 * 1000);

