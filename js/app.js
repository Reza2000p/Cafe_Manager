// ==========================================
// CAFE CLOVER - APPLICATION LOGIC (APP.JS)
// ==========================================

// CUSTOM BOOTSTRAP MODALS (REPLACING BROWSER CONFIRM & PROMPT)
function showConfirmModal(title, text) {
    return new Promise((resolve) => {
        document.getElementById('confirmModalTitle').textContent = title || 'تأیید عملیات';
        document.getElementById('confirmModalBody').textContent = text || 'آیا مطمئن هستید؟';
        const modal = new bootstrap.Modal(document.getElementById('confirmModal'));
        const actionBtn = document.getElementById('confirmModalActionBtn');
        
        const onConfirm = () => {
            actionBtn.removeEventListener('click', onConfirm);
            modal.hide();
            resolve(true);
        };
        
        actionBtn.onclick = onConfirm;
        modal.show();
    });
}

function showInputModal(title, label, defaultValue = '') {
    return new Promise((resolve) => {
        document.getElementById('inputModalTitle').textContent = title || 'ورود اطلاعات';
        document.getElementById('inputModalLabel').textContent = label || 'مقدار:';
        const inputEl = document.getElementById('inputModalValue');
        inputEl.value = defaultValue;
        
        const modal = new bootstrap.Modal(document.getElementById('inputModal'));
        const actionBtn = document.getElementById('inputModalActionBtn');
        
        const onConfirm = () => {
            const val = inputEl.value;
            actionBtn.removeEventListener('click', onConfirm);
            modal.hide();
            resolve(val ? val.trim() : null);
        };
        
        actionBtn.onclick = onConfirm;
        modal.show();
    });
}

// 1. INITIALIZATION & AUTH
async function initApp() {
    uiLoading(true);
    try {
        if (!supa) {
            showPage('login');
            uiLoading(false);
            return;
        }
        const { data: { session }, error } = await supa.auth.getSession();
        if (error) throw error;

        if (session) {
            currentUser = session.user;
            await loadInitialData();
            document.getElementById('logoutBtn').style.display = 'inline';
            showPage('dashboard');
            initRealtime();
            startLiveTimerTicker();
        } else {
            showPage('login');
        }
    } catch (err) {
        console.error('Init app error:', err);
        toast('خطا در برقراری ارتباط با سرور', 'danger');
        showPage('login');
    } finally {
        uiLoading(false);
    }

    supa.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_OUT') {
            currentUser = null;
            userProfile = null;
            document.getElementById('logoutBtn').style.display = 'none';
            showPage('login');
        }
    });
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    uiLoading(true);
    try {
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value.trim();
        const { data, error } = await supa.auth.signInWithPassword({ email, password });
        if (error) {
            toast('ایمیل یا رمز عبور اشتباه است', 'danger');
        } else {
            currentUser = data.user;
            await loadInitialData();
            document.getElementById('logoutBtn').style.display = 'inline';
            document.getElementById('loginEmail').value = '';
            document.getElementById('loginPassword').value = '';
            toast('با موفقیت وارد شدید');
            logSystemAction('ورود به سیستم', `ورود کاربر ${currentUser.email}`);
            showPage('dashboard');
            initRealtime();
            startLiveTimerTicker();
        }
    } catch (err) {
        console.error('Login error:', err);
        toast('خطا در ورود به سیستم', 'danger');
    } finally {
        uiLoading(false);
    }
});

document.getElementById('logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    logSystemAction('خروج از سیستم', `خروج کاربر ${currentUser ? currentUser.email : ''}`);
    await supa.auth.signOut();
});

// 2. DATA LOADING & REALTIME PERSISTENCE
async function loadInitialData() {
    try {
        const { data: prof } = await supa.from('profiles').select('*').eq('id', currentUser.id).single();
        userProfile = prof || { full_name: currentUser.email, role: 'staff' };
        document.getElementById('currentUser').textContent = userProfile.full_name || currentUser.email;

        const [menuRes, catsRes, ordersRes, profilesRes, custRes, logsRes, activeSessionsRes] = await Promise.all([
            supa.from('menu_items').select('*'),
            supa.from('categories').select('*'),
            supa.from('orders').select('*').order('created_at', { ascending: false }),
            supa.from('profiles').select('*'),
            supa.from('customers').select('*').order('created_at', { ascending: false }),
            supa.from('system_logs').select('*').order('created_at', { ascending: false }).limit(100),
            supa.from('active_timer_sessions').select('*')
        ]);

        localMenu = menuRes.data || [];
        localCats = catsRes.data || [];
        localOrders = ordersRes.data || [];
        localProfiles = profilesRes.data || [];
        localCustomers = custRes.data || [];
        localLogs = logsRes.data || [];

        if (activeSessionsRes && activeSessionsRes.data) {
            parseSupabaseActiveSessions(activeSessionsRes.data);
        }

        populateFilters();
        populateCatSelects();
    } catch (err) {
        console.error('Load initial data error:', err);
        toast('خطا در دریافت اطلاعات اولیه', 'danger');
    }
}

// SILENT REFRESH DATA (NO UI SPINNER FLICKER)
let isRefreshingSilently = false;
async function silentRefreshData() {
    if (isRefreshingSilently || !currentUser) return;
    isRefreshingSilently = true;
    try {
        const [ordersRes, menuRes, catsRes, activeSessionsRes] = await Promise.all([
            supa.from('orders').select('*').order('created_at', { ascending: false }),
            supa.from('menu_items').select('*'),
            supa.from('categories').select('*'),
            supa.from('active_timer_sessions').select('*')
        ]);

        if (ordersRes && ordersRes.data) localOrders = ordersRes.data;
        if (menuRes && menuRes.data) localMenu = menuRes.data;
        if (catsRes && catsRes.data) localCats = catsRes.data;
        if (activeSessionsRes && activeSessionsRes.data) parseSupabaseActiveSessions(activeSessionsRes.data);

        // SILENTLY RE-RENDER ACTIVE VIEW
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'page-orders') {
            const activeOrderTab = document.querySelector('#orderTabs .nav-link.active')?.dataset?.tab;
            if (activeOrderTab === 'timers') updateLiveDeviceCardsUI();
            if (activeOrderTab === 'settle') renderSettlement();
            if (activeOrderTab === 'history') renderHistory();
        } else if (activePage === 'page-dashboard') {
            renderDashboard();
        } else if (activePage === 'page-menu') {
            renderMenu();
        }
    } catch(e) {
    } finally {
        isRefreshingSilently = false;
    }
}

// BROADCAST SIGNAL TO ALL CONNECTED CLIENTS
function broadcastGlobalSync() {
    if (supa) {
        try {
            supa.channel('global-cafe-channel').send({
                type: 'broadcast',
                event: 'sync_all'
            });
        } catch(e){}
    }
}

function initRealtime() {
    if (!supa) return;
    
    const channel = supa.channel('global-cafe-channel');

    // 1. Broadcast Listener (Fires INSTANTLY across all devices and phones)
    channel.on('broadcast', { event: 'sync_all' }, async () => {
        await silentRefreshData();
    });

    // 2. Postgres DB Changes Listener
    channel.on('postgres_changes', { event: '*', schema: 'public' }, async () => {
        await silentRefreshData();
    });

    channel.subscribe();

    // 3. Fallback Polling (Every 3 Seconds) for 100% Reliability on Shaky Mobile Networks
    setInterval(async () => {
        await silentRefreshData();
    }, 3000);
}

async function refreshOrders() {
    await silentRefreshData();
}

async function refreshMenu() {
    await silentRefreshData();
}

async function refreshCats() {
    await silentRefreshData();
}

async function refreshCustomers() {
    await silentRefreshData();
}

function populateFilters() {
    const uniqueUsers = [...new Set(localProfiles.map(p => p.full_name).filter(Boolean))];
    const opts = '<option value="">همه پرسنل</option>' + uniqueUsers.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
    
    ['histCreatedUserFilter', 'histSettledUserFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
    });
}

function populateCatSelects(forTimer = false) {
    const staticCats = localCats.filter(c => c.is_timer !== true && c.type !== 'timer');
    const timerCats = localCats.filter(c => c.is_timer === true || c.type === 'timer');

    const menuCatSelect = document.getElementById('menuFormCat');
    if (menuCatSelect) {
        const targetCats = forTimer ? timerCats : staticCats;
        menuCatSelect.innerHTML = targetCats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    }

    const staticFilter = document.getElementById('menuCatFilter');
    if (staticFilter) {
        staticFilter.innerHTML = `<option value="">همه دسته‌ها</option>` + staticCats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    }

    const timerFilter = document.getElementById('timerDeviceCatFilter');
    if (timerFilter) {
        timerFilter.innerHTML = `<option value="">همه دسته‌بندی‌های دستگاه‌ها</option>` + timerCats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    }
}

// 3. NAVIGATION & TABS
function showPage(page) {
    if (!currentUser && page !== 'login') return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const targetPage = document.getElementById(`page-${page}`);
    if (targetPage) targetPage.classList.add('active');

    document.querySelectorAll('.bottom-nav .nav-item, .desktop-nav .nav-item').forEach(b => {
        b.classList.toggle('active', b.dataset.page === page);
    });

    if (page !== 'login') {
        if (page === 'dashboard') renderDashboard();
        if (page === 'menu') { renderMenu(); renderCats(); populateCatSelects(); }
        if (page === 'orders') { renderOrdersTab(); renderSettlement(); }
        if (page === 'reports') { renderReports(); }
        if (page === 'system') { renderUsers(); renderCustomersList(); }
    }
}

document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', function() {
        if (this.dataset.page) showPage(this.dataset.page);
    });
});

function setupTabs(navId, contentId, callback) {
    document.querySelectorAll(`#${navId} .nav-link`).forEach(tab => {
        tab.addEventListener('click', function() {
            document.querySelectorAll(`#${navId} .nav-link`).forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            document.querySelectorAll(`#${contentId} > .tab-pane`).forEach(p => p.classList.remove('active'));
            const target = document.querySelector(`#${contentId} > [id$="${this.dataset.tab}"]`);
            if (target) target.classList.add('active');
            if (callback) callback(this.dataset.tab);
        });
    });
}

setupTabs('orderTabs', 'orderTabContent', (tab) => {
    if (tab === 'settle') renderSettlement();
    if (tab === 'history') renderHistory();
    if (tab === 'timers') updateLiveDeviceCardsUI();
});
setupTabs('menuTabs', 'menuTabContent', null);
setupTabs('systemTabs', 'systemTabContent', null);
setupTabs('historySubTabs', 'historySubTabContent', (tab) => { renderHistory(); });
setupTabs('catSubTabs', 'catSubTabContent', (tab) => { renderCats(); });
setupTabs('reportSubTabs', 'reportSubTabContent', (tab) => { renderReports(); });

document.addEventListener('DOMContentLoaded', () => {
    const tSearch = document.getElementById('timerDeviceSearch');
    const tCat = document.getElementById('timerDeviceCatFilter');
    if (tSearch) tSearch.addEventListener('input', updateLiveDeviceCardsUI);
    if (tCat) tCat.addEventListener('change', updateLiveDeviceCardsUI);
});

// 4. DASHBOARD
document.getElementById('dashTimeFilter').addEventListener('change', renderDashboard);

function renderDashboard() {
    const timeFilter = document.getElementById('dashTimeFilter').value;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    let targetOrders = localOrders.filter(o => o.status !== 'لغو');

    if (timeFilter === 'today') targetOrders = targetOrders.filter(o => new Date(o.created_at) >= startOfToday);
    else if (timeFilter === 'week' || timeFilter === 'month') {
        const limitDate = new Date(startOfToday);
        limitDate.setDate(limitDate.getDate() - (timeFilter === 'week' ? 7 : 30) + 1);
        targetOrders = targetOrders.filter(o => new Date(o.created_at) >= limitDate);
    }

    const settledOrders = targetOrders.filter(o => o.status !== 'معلق');
    const totalSales = settledOrders.reduce((s, o) => s + (o.total || 0), 0);

    let staticRevenue = 0;
    let timerRevenue = 0;

    settledOrders.forEach(o => {
        (o.items || []).forEach(i => {
            if (i.type === 'timer' || i.hourly_rate) {
                timerRevenue += (i.price || 0);
            } else {
                staticRevenue += (i.price || 0) * (i.qty || 1);
            }
        });
    });

    document.getElementById('dashboardStats').innerHTML = `
        <div class="col-6 col-md-3"><div class="stat-card"><div class="icon-box bg-primary text-white"><i class="fas fa-receipt"></i></div><h5>${settledOrders.length}</h5><small>فاکتور تسویه‌شده</small></div></div>
        <div class="col-6 col-md-3"><div class="stat-card"><div class="icon-box bg-success text-white"><i class="fas fa-wallet"></i></div><h5>${formatPrice(totalSales)}</h5><small>درآمد کل (تومان)</small></div></div>
        <div class="col-6 col-md-3"><div class="stat-card"><div class="icon-box bg-info text-white"><i class="fas fa-coffee"></i></div><h5>${formatPrice(staticRevenue)}</h5><small>درآمد ثابت‌ها (بوفه)</small></div></div>
        <div class="col-6 col-md-3"><div class="stat-card"><div class="icon-box bg-warning text-dark"><i class="fas fa-gamepad"></i></div><h5>${formatPrice(timerRevenue)}</h5><small>درآمد تایمری‌ها (دستگاه)</small></div></div>
    `;

    // Top Static Items
    const itemMap = {};
    settledOrders.forEach(o => {
        (o.items || []).forEach(i => {
            if (i.type !== 'timer' && !i.hourly_rate) itemMap[i.name] = (itemMap[i.name] || 0) + (i.qty || 1);
        });
    });
    const topItems = Object.entries(itemMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    document.getElementById('topItems').innerHTML = topItems.length ? topItems.map(i => `<div class="d-flex justify-content-between border-bottom py-2 small"><span>${escapeHtml(i[0])}</span> <span class="fw-bold text-primary">${i[1]} عدد</span></div>`).join('') : '<div class="empty-state">داده‌ای نیست</div>';

    // Top Timer Devices
    const deviceMap = {};
    settledOrders.forEach(o => {
        (o.items || []).forEach(i => {
            if (i.type === 'timer' || i.hourly_rate) {
                const dName = i.device_name || i.name;
                if (!deviceMap[dName]) deviceMap[dName] = { mins: 0, revenue: 0 };
                deviceMap[dName].mins += (i.duration_mins || 0);
                deviceMap[dName].revenue += (i.price || 0);
            }
        });
    });
    const topDevices = Object.entries(deviceMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
    document.getElementById('topDevicesList').innerHTML = topDevices.length ? topDevices.map(d => `<div class="d-flex justify-content-between border-bottom py-2 small"><span>${escapeHtml(d[0])}</span> <span class="fw-bold text-success">${formatPrice(d[1].revenue)} ت (${d[1].mins} دقیقه‌)</span></div>`).join('') : '<div class="empty-state">داده‌ای نیست</div>';

    // Top Customers
    const custMap = {};
    settledOrders.forEach(o => { if (o.customer_name) custMap[o.customer_name] = (custMap[o.customer_name] || 0) + (o.total || 0); });
    const topCust = Object.entries(custMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    document.getElementById('topCustomersList').innerHTML = topCust.length ? topCust.map(i => `<div class="d-flex justify-content-between border-bottom py-2 small"><span>${escapeHtml(i[0])}</span> <span class="fw-bold text-success">${formatPrice(i[1])} ت</span></div>`).join('') : '<div class="empty-state">داده‌ای نیست</div>';

    // Recent Orders
    const recent = settledOrders.slice(0, 5);
    document.getElementById('recentOrders').innerHTML = recent.length ? recent.map(o => `<div class="d-flex justify-content-between border-bottom py-2 small"><span>#${o.id} ${escapeHtml(o.customer_name)}</span><span class="fw-bold">${formatPrice(o.total)}</span></div>`).join('') : '<div class="empty-state">داده‌ای نیست</div>';
}

// 5. MENU & CATEGORIES MANAGEMENT
function renderMenu() {
    const q = document.getElementById('menuSearch').value.trim().toLowerCase();
    const c = document.getElementById('menuCatFilter').value;

    const staticItems = localMenu.filter(it => !it.is_timer && it.name.toLowerCase().includes(q) && (c ? it.cat === c : true));
    const timerDevices = localMenu.filter(it => it.is_timer && it.name.toLowerCase().includes(q) && (c ? it.cat === c : true));

    // Render Static Items Tab
    document.getElementById('staticMenuList').innerHTML = staticItems.length ? staticItems.map(it => `
        <div class="d-flex justify-content-between align-items-center border-bottom py-3">
            <div><strong class="fs-6">${escapeHtml(it.name)}</strong><span class="badge bg-light text-dark ms-2 border">${escapeHtml(it.cat)}</span><div class="text-primary fw-bold mt-1">${formatPrice(it.price)} تومان</div></div>
            <div><button class="btn btn-sm btn-outline-warning" onclick="editMenu(${it.id})"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-outline-danger" onclick="deleteMenu(${it.id})"><i class="fas fa-trash"></i></button></div>
        </div>
    `).join('') : '<div class="empty-state">آیتم ثابتی یافت نشد</div>';

    // Render Timer Devices Tab
    document.getElementById('timerMenuList').innerHTML = timerDevices.length ? timerDevices.map(it => `
        <div class="d-flex justify-content-between align-items-center border-bottom py-3">
            <div><strong class="fs-6"><i class="fas fa-gamepad text-warning me-1"></i> ${escapeHtml(it.name)}</strong><span class="badge bg-light text-dark ms-2 border">${escapeHtml(it.cat)}</span><div class="text-success fw-bold mt-1">نرخ هر ساعت: ${formatPrice(it.hourly_rate || it.price)} تومان</div></div>
            <div><button class="btn btn-sm btn-outline-warning" onclick="editMenu(${it.id})"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-outline-danger" onclick="deleteMenu(${it.id})"><i class="fas fa-trash"></i></button></div>
        </div>
    `).join('') : '<div class="empty-state">دستگاه تایمری یافت نشد</div>';
}

document.getElementById('menuSearch').addEventListener('input', renderMenu);
document.getElementById('menuCatFilter').addEventListener('change', renderMenu);

document.getElementById('addStaticItemBtn').addEventListener('click', () => {
    populateCatSelects(false);
    document.getElementById('menuFormId').value = '';
    document.getElementById('menuFormIsTimer').value = 'false';
    document.getElementById('menuModalTitle').textContent = 'افزودن آیتم ثابت (بوفه)';
    document.getElementById('priceLabel').textContent = 'قیمت ثابت (تومان)';
    document.getElementById('menuFormName').value = '';
    document.getElementById('menuFormPrice').value = '';
    new bootstrap.Modal(document.getElementById('menuModal')).show();
});

document.getElementById('addTimerDeviceBtn').addEventListener('click', () => {
    populateCatSelects(true);
    document.getElementById('menuFormId').value = '';
    document.getElementById('menuFormIsTimer').value = 'true';
    document.getElementById('menuModalTitle').textContent = 'افزودن دستگاه تایمری جدید';
    document.getElementById('priceLabel').textContent = 'نرخ هر ۱ ساعت (تومان)';
    document.getElementById('menuFormName').value = '';
    document.getElementById('menuFormPrice').value = '';
    new bootstrap.Modal(document.getElementById('menuModal')).show();
});

window.editMenu = function(id) {
    const item = localMenu.find(i => i.id === id);
    if (!item) return;
    populateCatSelects(item.is_timer);
    document.getElementById('menuFormId').value = id;
    document.getElementById('menuFormIsTimer').value = item.is_timer ? 'true' : 'false';
    document.getElementById('menuModalTitle').textContent = item.is_timer ? 'ویرایش دستگاه تایمری' : 'ویرایش آیتم ثابت';
    document.getElementById('priceLabel').textContent = item.is_timer ? 'نرخ هر ۱ ساعت (تومان)' : 'قیمت ثابت (تومان)';
    document.getElementById('menuFormName').value = item.name;
    document.getElementById('menuFormPrice').value = item.is_timer ? (item.hourly_rate || item.price) : item.price;
    document.getElementById('menuFormCat').value = item.cat || '';
    new bootstrap.Modal(document.getElementById('menuModal')).show();
};

window.deleteMenu = async function(id) {
    const confirmDelete = await showConfirmModal('حذف منو/دستگاه', 'آیا از حذف این آیتم اطمینان دارید؟');
    if (!confirmDelete) return;

    uiLoading(true);
    try {
        const item = localMenu.find(i => i.id === id);
        const { error } = await supa.from('menu_items').delete().eq('id', id);
        if (error) throw error;
        toast('با موفقیت حذف شد');
        logSystemAction('حذف منو/دستگاه', `حذف ${item ? item.name : id}`);
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) {
        console.error('Delete menu error:', err);
        toast('خطا در حذف', 'danger');
    } finally {
        uiLoading(false);
    }
};

document.getElementById('menuFormSave').addEventListener('click', async () => {
    const id = document.getElementById('menuFormId').value;
    const isTimer = document.getElementById('menuFormIsTimer').value === 'true';
    const name = document.getElementById('menuFormName').value.trim();
    const price = parseInt(document.getElementById('menuFormPrice').value);
    const cat = document.getElementById('menuFormCat').value;

    if (!name || isNaN(price) || price < 0) {
        toast('نام یا مبلغ نامعتبر است', 'danger');
        return;
    }

    uiLoading(true);
    try {
        const payload = { name, cat, price: price, is_timer: isTimer, hourly_rate: isTimer ? price : 0 };
        let error;
        if (id) {
            ({ error } = await supa.from('menu_items').update(payload).eq('id', id));
        } else {
            ({ error } = await supa.from('menu_items').insert([payload]));
        }
        if (error) throw error;
        toast('اطلاعات با موفقیت ذخیره شد');
        logSystemAction('ذخیره منو/دستگاه', `${isTimer ? 'دستگاه' : 'آیتم'} ${name} ذخیره شد`);
        bootstrap.Modal.getInstance(document.getElementById('menuModal')).hide();
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) {
        console.error('Save menu error:', err);
        toast('خطا در ذخیره‌سازی', 'danger');
    } finally {
        uiLoading(false);
    }
});

function renderCats() {
    const staticCats = localCats.filter(c => c.is_timer !== true && c.type !== 'timer');
    const timerCats = localCats.filter(c => c.is_timer === true || c.type === 'timer');

    document.getElementById('catStaticList').innerHTML = staticCats.length ? staticCats.map(c => `
        <li class="list-group-item d-flex justify-content-between align-items-center p-2">
            <span>${escapeHtml(c.name)}</span>
            <div>
                <button class="btn btn-sm btn-outline-warning py-0 me-1" onclick="editCat(${c.id}, '${escapeHtml(c.name)}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-danger py-0" onclick="deleteCat(${c.id})"><i class="fas fa-trash"></i></button>
            </div>
        </li>
    `).join('') : '<li class="list-group-item text-muted">هیچ دسته‌بندی ثابتی وجود ندارد</li>';

    document.getElementById('catTimerList').innerHTML = timerCats.length ? timerCats.map(c => `
        <li class="list-group-item d-flex justify-content-between align-items-center p-2">
            <span><i class="fas fa-gamepad me-1 text-primary"></i> ${escapeHtml(c.name)}</span>
            <div>
                <button class="btn btn-sm btn-outline-warning py-0 me-1" onclick="editCat(${c.id}, '${escapeHtml(c.name)}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-danger py-0" onclick="deleteCat(${c.id})"><i class="fas fa-trash"></i></button>
            </div>
        </li>
    `).join('') : '<li class="list-group-item text-muted">هیچ دسته‌بندی تایمری وجود ندارد</li>';
}

document.getElementById('addCatStaticBtn').addEventListener('click', async () => {
    const name = document.getElementById('newCatStaticName').value.trim();
    if (!name) { toast('نام دسته الزامی است', 'danger'); return; }
    uiLoading(true);
    try {
        let payload = { name, is_timer: false, type: 'static' };
        let { error } = await supa.from('categories').insert([payload]);
        if (error) {
            ({ error } = await supa.from('categories').insert([{ name }]));
        }
        if (error) throw error;

        document.getElementById('newCatStaticName').value = '';
        toast('دسته‌بندی ثابت‌ها افزوده شد');
        logSystemAction('افزودن دسته‌بندی', `دسته ثابت ${name} افزوده شد`);
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) { console.error('Add cat error:', err); toast('خطا در ثبت دسته', 'danger'); }
    finally { uiLoading(false); }
});

document.getElementById('addCatTimerBtn').addEventListener('click', async () => {
    const name = document.getElementById('newCatTimerName').value.trim();
    if (!name) { toast('نام دسته الزامی است', 'danger'); return; }
    uiLoading(true);
    try {
        let payload = { name, is_timer: true, type: 'timer' };
        let { error } = await supa.from('categories').insert([payload]);
        if (error) {
            ({ error } = await supa.from('categories').insert([{ name: `${name} (تایمری)` }]));
        }
        if (error) throw error;

        document.getElementById('newCatTimerName').value = '';
        toast('دسته‌بندی تایمری‌ها افزوده شد');
        logSystemAction('افزودن دسته‌بندی', `دسته تایمری ${name} افزوده شد`);
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) { console.error('Add cat error:', err); toast('خطا در ثبت دسته', 'danger'); }
    finally { uiLoading(false); }
});

window.editCat = async function(id, oldName) {
    const newName = await showInputModal('ویرایش دسته‌بندی', 'نام جدید دسته‌بندی را وارد کنید:', oldName);
    if (!newName || newName === oldName) return;
    uiLoading(true);
    try {
        const { error } = await supa.from('categories').update({ name: newName }).eq('id', id);
        if (error) throw error;
        toast('دسته‌بندی با موفقیت ویرایش شد');
        logSystemAction('ویرایش دسته‌بندی', `تغییر نام دسته از ${oldName} به ${newName}`);
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) { console.error('Edit cat error:', err); toast('خطا در ویرایش دسته', 'danger'); }
    finally { uiLoading(false); }
};

window.deleteCat = async function(id) {
    const confirmDelete = await showConfirmModal('حذف دسته‌بندی', 'آیا از حذف این دسته‌بندی اطمینان دارید؟');
    if (!confirmDelete) return;

    uiLoading(true);
    try {
        const { error } = await supa.from('categories').delete().eq('id', id);
        if (error) throw error;
        toast('دسته حذف شد');
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) { console.error('Delete cat error:', err); toast('خطا در حذف دسته', 'danger'); }
    finally { uiLoading(false); }
};

// 6. ORDERS & TIMERS TAB
function renderOrdersTab() {
    renderCart();
    updateLiveDeviceCardsUI();
}

const searchInput = document.getElementById('searchItem');
const searchRes = document.getElementById('itemSearchResults');

searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { searchRes.style.display = 'none'; return; }
    const items = localMenu.filter(i => !i.is_timer && i.name.toLowerCase().includes(q));
    searchRes.innerHTML = items.length ? items.map(i => `
        <div class="p-2 border-bottom d-flex justify-content-between" style="cursor:pointer;" onclick="addToCart(${i.id})">
            <span>${escapeHtml(i.name)}</span><span class="text-primary fw-bold">${formatPrice(i.price)} تومان</span>
        </div>
    `).join('') : '<div class="p-2 text-muted small">یافت نشد</div>';
    searchRes.style.display = 'block';
});
document.addEventListener('click', (e) => { if (!searchRes.contains(e.target) && e.target !== searchInput) searchRes.style.display = 'none'; });

window.addToCart = function(id) {
    const item = localMenu.find(i => i.id === id);
    if (!item) return;
    const exist = cart.find(c => c.id === id);
    if (exist) exist.qty++;
    else cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, type: 'static' });
    searchInput.value = '';
    searchRes.style.display = 'none';
    renderCart();
    toast('به سبد اضافه شد');
};

function renderCart() {
    const cdiv = document.getElementById('cartItems');
    let total = 0;
    if (!cart.length) cdiv.innerHTML = '<div class="empty-state">سبد خرید بوفه خالی است</div>';
    else cdiv.innerHTML = cart.map((c, i) => {
        total += c.price * c.qty;
        return `
            <div class="d-flex align-items-center justify-content-between border-bottom py-2">
                <div style="flex:1;"><strong>${escapeHtml(c.name)}</strong></div>
                <div class="d-flex align-items-center gap-2 me-3">
                    <button class="btn btn-sm btn-light border" onclick="updateQty(${i}, -1)">-</button>
                    <span class="fw-bold" style="min-width:20px;text-align:center">${c.qty}</span>
                    <button class="btn btn-sm btn-light border" onclick="updateQty(${i}, 1)">+</button>
                </div>
                <div class="text-primary fw-bold me-2" style="min-width:80px;text-align:left">${formatPrice(c.price * c.qty)} تومان</div>
                <button class="btn btn-sm text-danger" onclick="cart.splice(${i},1);renderCart()"><i class="fas fa-trash"></i></button>
            </div>
        `;
    }).join('');
    document.getElementById('cartTotal').textContent = formatPrice(total);
    document.getElementById('cartCount').textContent = cart.reduce((s, c) => s + c.qty, 0);
}

window.updateQty = function(idx, val) {
    cart[idx].qty += val;
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
    renderCart();
};

document.getElementById('submitOrderBtn').addEventListener('click', async () => {
    if (!cart.length) { toast('سبد خرید خالی است', 'danger'); return; }
    const custName = document.getElementById('customerName').value.trim();
    if (!custName) { toast('نام مشتری الزامی است', 'danger'); return; }

    uiLoading(true);
    try {
        const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
        await supa.from('customers').upsert({ full_name: custName }, { onConflict: 'full_name' });
        const createdBy = (userProfile && userProfile.full_name) ? userProfile.full_name : currentUser.email;
        
        const { error } = await supa.from('orders').insert([{
            customer_name: custName,
            items: cart,
            total: total,
            status: 'معلق',
            created_by: createdBy
        }]);
        if (error) throw error;
        
        cart = [];
        document.getElementById('customerName').value = '';
        renderCart();
        toast('سفارش بوفه ثبت شد');
        logSystemAction('ثبت سفارش بوفه', `ثبت سفارش برای ${custName} به مبلغ ${formatPrice(total)} تومان`);
        await silentRefreshData();
        broadcastGlobalSync();
        document.querySelector('[data-tab="settle"]').click();
    } catch (err) {
        console.error('Submit order error:', err);
        toast('خطا در ثبت سفارش', 'danger');
    } finally {
        uiLoading(false);
    }
});

// 7. SETTLEMENT TAB (INSTANT REFRESH ON ACTION WITH START & END TIME)
document.getElementById('settleSearch').addEventListener('input', renderSettlement);

function renderSettlement() {
    const sq = document.getElementById('settleSearch').value.trim().toLowerCase();
    let pending = localOrders.filter(o => o.status === 'معلق');
    if (sq) pending = pending.filter(o => (o.customer_name || '').toLowerCase().includes(sq));

    const groups = {};
    pending.forEach(o => {
        const c = o.customer_name || 'بدون نام';
        if (!groups[c]) groups[c] = { ids: [], total: 0, items: [] };
        groups[c].ids.push(o.id);
        groups[c].total += (o.total || 0);
        (o.items || []).forEach(it => groups[c].items.push(it));
    });

    const listDiv = document.getElementById('pendingOrdersList');
    const keys = Object.keys(groups);
    if (!keys.length) { listDiv.innerHTML = '<div class="empty-state">هیچ فاکتور معلقی جهت تسویه وجود ندارد</div>'; return; }

    listDiv.innerHTML = keys.map(custName => {
        const g = groups[custName];
        const idsJson = escapeHtml(JSON.stringify(g.ids));
        
        const timerItems = g.items.filter(i => i.type === 'timer' || i.hourly_rate);
        const staticItems = g.items.filter(i => i.type !== 'timer' && !i.hourly_rate);

        let timerRows = timerItems.map(t => {
            let timeRange = '';
            const sTime = t.start_time_str || (t.start_time ? new Date(t.start_time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '');
            const eTime = t.end_time_str || (t.end_time ? new Date(t.end_time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '');
            if (sTime && eTime) {
                timeRange = ` (از ${sTime} تا ${eTime})`;
            }

            return `
                <div class="invoice-item-row">
                    <span><i class="fas fa-gamepad text-warning me-1"></i> ${escapeHtml(t.name || t.device_name)}${timeRange} - ${t.duration_mins || 0} دقیقه</span>
                    <span class="fw-bold">${formatPrice(t.price)} تومان</span>
                </div>
            `;
        }).join('');

        let staticRows = staticItems.map(s => `
            <div class="invoice-item-row">
                <span><i class="fas fa-coffee text-info me-1"></i> ${escapeHtml(s.name)} (x${s.qty || 1})</span>
                <span class="fw-bold">${formatPrice((s.price || 0) * (s.qty || 1))} تومان</span>
            </div>
        `).join('');

        return `
            <div class="invoice-card">
                <div class="invoice-header">
                    <div>
                        <strong class="fs-5 text-dark"><i class="fas fa-user-circle text-primary me-1"></i> ${escapeHtml(custName)}</strong>
                    </div>
                    <div class="text-end">
                        <div class="fs-5 fw-bold text-success">${formatPrice(g.total)} تومان</div>
                        <small class="text-muted">${g.ids.length} فاکتور معلق</small>
                    </div>
                </div>

                <div class="invoice-details mb-3">
                    ${timerItems.length ? `<div class="invoice-section-title"><i class="fas fa-stopwatch text-warning me-1"></i> ریز خدمات دستگاه‌ها:</div>${timerRows}` : ''}
                    ${staticItems.length ? `<div class="invoice-section-title"><i class="fas fa-utensils text-info me-1"></i> ریز اقلام بوفه:</div>${staticRows}` : ''}
                    <div class="invoice-total-row">
                        <span>مجموع قابل پرداخت:</span>
                        <span>${formatPrice(g.total)} تومان</span>
                    </div>
                </div>

                <div class="d-flex gap-2">
                    <button class="btn btn-success-custom flex-fill py-2" onclick='settleCustomerGroup(${idsJson}, "نقدی", "${escapeHtml(custName)}")'><i class="fas fa-money-bill-wave me-1"></i> تسویه نقدی</button>
                    <button class="btn btn-primary-custom flex-fill py-2" onclick='settleCustomerGroup(${idsJson}, "کارت", "${escapeHtml(custName)}")'><i class="fas fa-credit-card me-1"></i> تسویه کارتخوان</button>
                    <button class="btn btn-outline-danger" onclick='settleCustomerGroup(${idsJson}, "لغو", "${escapeHtml(custName)}")'><i class="fas fa-times"></i> لغو</button>
                </div>
            </div>
        `;
    }).join('');
}

window.settleCustomerGroup = async function(idsArray, method, customerName) {
    if (method === 'لغو') {
        const confirmCancel = await showConfirmModal('لغو سفارشات', `آیا تمامی سفارشات ${customerName} لغو شوند؟`);
        if (!confirmCancel) return;
    }
    uiLoading(true);
    try {
        const settledBy = (userProfile && userProfile.full_name) ? userProfile.full_name : currentUser.email;
        const payload = { status: method, settled_by: settledBy };
        
        const { error } = await supa.from('orders').update(payload).in('id', idsArray);
        if (error) throw error;

        toast(`تسویه حساب ${customerName} با موفقیت ثبت شد (${method})`);
        logSystemAction('تسویه حساب', `تسویه فاکتور ${customerName} به روش ${method} توسط ${settledBy}`);
        
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) {
        console.error('Settle group error:', err);
        toast('خطا در تسویه حساب', 'danger');
    } finally {
        uiLoading(false);
    }
};

// 8. HISTORY
window.exportHistoryCSV = function() {
    if (!localOrders || !localOrders.length) {
        toast('تاریخچه‌ای برای دانلود وجود ندارد', 'warning');
        return;
    }

    let csvContent = "\uFEFFشماره سفارش,مشتری,مبلغ (تومان),وضعیت,ثبت کننده,تسویه کننده,تاریخ و ساعت\n";
    localOrders.forEach(o => {
        const d = new Date(o.created_at);
        const dateStr = d.toLocaleDateString('fa-IR') + ' ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
        csvContent += `"${o.id}","${o.customer_name || ''}","${o.total || 0}","${o.status || ''}","${o.created_by || ''}","${o.settled_by || ''}","${dateStr}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `cafe_history_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('فایل CSV تاریخچه دانلود شد');
    logSystemAction('دانلود تاریخچه', 'دریافت خروجی CSV کل تاریخچه سفارشات');
};

function renderHistory() {
    const activeSubTab = document.querySelector('#historySubTabs .nav-link.active')?.dataset?.tab || 'created';

    if (activeSubTab === 'created') {
        const payF = document.getElementById('histCreatedPayFilter').value;
        const userF = document.getElementById('histCreatedUserFilter').value;
        const dateF = document.getElementById('histCreatedDateFilter').value;
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

        let filtered = localOrders.filter(o => o.status !== 'معلق');
        if (payF) filtered = filtered.filter(o => o.status === payF);
        if (userF) filtered = filtered.filter(o => o.created_by === userF);

        if (dateF === 'today') {
            filtered = filtered.filter(o => new Date(o.created_at) >= startOfToday);
        } else if (dateF === '3days' || dateF === 'week') {
            const limitDate = new Date(startOfToday);
            limitDate.setDate(limitDate.getDate() - (dateF === '3days' ? 2 : 6));
            filtered = filtered.filter(o => new Date(o.created_at) >= limitDate);
        }

        document.getElementById('historyCreatedList').innerHTML = filtered.length ? filtered.map(o => {
            const d = new Date(o.created_at);
            const dateStr = d.toLocaleDateString('fa-IR') + ' - ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
            return `
                <div class="border-bottom py-2">
                    <div class="d-flex justify-content-between mb-1">
                        <span class="fw-bold">#${o.id} ${escapeHtml(o.customer_name)}</span>
                        <span class="text-primary fw-bold">${formatPrice(o.total)} تومان</span>
                    </div>
                    <div class="d-flex justify-content-between align-items-center">
                        <div class="order-meta m-0"><i class="fas fa-clock me-1"></i> ${dateStr} | <i class="fas fa-user-edit me-1"></i> ثبت‌کننده: <strong>${escapeHtml(o.created_by || 'نامشخص')}</strong></div>
                        <span class="badge ${o.status === 'نقدی' ? 'bg-success' : o.status === 'کارت' ? 'bg-info' : 'bg-danger'}">${escapeHtml(o.status)}</span>
                    </div>
                </div>
            `;
        }).join('') : '<div class="empty-state">سفارشی ثبت نشده است</div>';
    } else {
        const payF = document.getElementById('histSettledPayFilter').value;
        const userF = document.getElementById('histSettledUserFilter').value;
        const dateF = document.getElementById('histSettledDateFilter').value;
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

        let filtered = localOrders.filter(o => o.status !== 'معلق');
        if (payF) filtered = filtered.filter(o => o.status === payF);
        if (userF) filtered = filtered.filter(o => o.settled_by === userF);

        if (dateF === 'today') {
            filtered = filtered.filter(o => new Date(o.created_at) >= startOfToday);
        } else if (dateF === '3days' || dateF === 'week') {
            const limitDate = new Date(startOfToday);
            limitDate.setDate(limitDate.getDate() - (dateF === '3days' ? 2 : 6));
            filtered = filtered.filter(o => new Date(o.created_at) >= limitDate);
        }

        document.getElementById('historySettledList').innerHTML = filtered.length ? filtered.map(o => {
            const d = new Date(o.created_at);
            const dateStr = d.toLocaleDateString('fa-IR') + ' - ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
            return `
                <div class="border-bottom py-2">
                    <div class="d-flex justify-content-between mb-1">
                        <span class="fw-bold">#${o.id} ${escapeHtml(o.customer_name)}</span>
                        <span class="text-success fw-bold">${formatPrice(o.total)} تومان</span>
                    </div>
                    <div class="d-flex justify-content-between align-items-center">
                        <div class="order-meta m-0"><i class="fas fa-check-circle text-success me-1"></i> ${dateStr} | <i class="fas fa-user-check me-1"></i> تسویه‌کننده: <strong>${escapeHtml(o.settled_by || o.created_by || 'نامشخص')}</strong></div>
                        <span class="badge ${o.status === 'نقدی' ? 'bg-success' : o.status === 'کارت' ? 'bg-info' : 'bg-danger'}">${escapeHtml(o.status)}</span>
                    </div>
                </div>
            `;
        }).join('') : '<div class="empty-state">تسویه‌ای ثبت نشده است</div>';
    }
}

['histCreatedPayFilter', 'histCreatedUserFilter', 'histCreatedDateFilter', 'histSettledPayFilter', 'histSettledUserFilter', 'histSettledDateFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderHistory);
});

// 9. REPORTS
window.setRepDate = function(mode, btnEl) {
    if (btnEl) {
        document.querySelectorAll('#page-reports .quick-date-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
    const dFrom = document.getElementById('reportDateFrom');
    const dTo = document.getElementById('reportDateTo');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    if (mode === 'today') { dFrom.value = todayStr; dTo.value = todayStr; }
    else if (mode === 'all') { dFrom.value = ''; dTo.value = ''; }
    else {
        const limit = new Date(now);
        if (mode === '3days') limit.setDate(limit.getDate() - 2);
        if (mode === 'week') limit.setDate(limit.getDate() - 6);
        if (mode === 'month') limit.setDate(limit.getDate() - 29);
        const lYear = limit.getFullYear();
        const lMonth = String(limit.getMonth() + 1).padStart(2, '0');
        const lDay = String(limit.getDate()).padStart(2, '0');
        dFrom.value = `${lYear}-${lMonth}-${lDay}`;
        dTo.value = todayStr;
    }
    renderReports();
};

document.getElementById('applyReportFilter').addEventListener('click', renderReports);

function renderReports() {
    const activeSubTab = document.querySelector('#reportSubTabs .nav-link.active')?.dataset?.tab || 'sales';
    const fromD = document.getElementById('reportDateFrom').value;
    const toD = document.getElementById('reportDateTo').value;

    let orders = localOrders.filter(o => o.status !== 'معلق' && o.status !== 'لغو');
    if (fromD) {
        const fromDate = new Date(fromD + 'T00:00:00');
        orders = orders.filter(o => new Date(o.created_at) >= fromDate);
    }
    if (toD) {
        const toDate = new Date(toD + 'T23:59:59.999');
        orders = orders.filter(o => new Date(o.created_at) <= toDate);
    }

    if (activeSubTab === 'sales') {
        const totalRev = orders.reduce((s, o) => s + (o.total || 0), 0);
        const totalCash = orders.filter(o => o.status === 'نقدی').reduce((s, o) => s + (o.total || 0), 0);
        const totalCard = orders.filter(o => o.status === 'کارت').reduce((s, o) => s + (o.total || 0), 0);

        let itemsMap = {};
        orders.forEach(o => {
            (o.items || []).forEach(i => {
                if (!itemsMap[i.name]) itemsMap[i.name] = { qty: 0, revenue: 0 };
                itemsMap[i.name].qty += (i.qty || 1);
                itemsMap[i.name].revenue += (i.price || 0) * (i.qty || 1);
            });
        });
        const sortedItems = Object.entries(itemsMap).sort((a, b) => b[1].qty - a[1].qty);

        document.getElementById('salesReportContent').innerHTML = `
            <div id="printableReport" class="alert alert-light border shadow-sm mt-3" style="direction:rtl; text-align:right;">
                <h5 class="text-center text-primary mb-3 fw-bold">آمار دقیق فروش</h5>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>فاکتورهای تسویه شده:</span> <strong>${orders.length} عدد</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>مجموع نقدی:</span> <strong class="text-success">${formatPrice(totalCash)} تومان</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>مجموع کارتخوان:</span> <strong class="text-info">${formatPrice(totalCard)} تومان</strong></div>
                <div class="d-flex justify-content-between mt-3 fs-5 border-bottom pb-2 mb-3"><span>کل درآمد:</span> <strong class="text-primary">${formatPrice(totalRev)} تومان</strong></div>
                
                <h6 class="fw-bold mt-2 text-dark"><i class="fas fa-list me-1"></i> ریز اقلام و خدمات فروخته شده:</h6>
                <ul class="list-group list-group-flush small">
                    ${sortedItems.length ? sortedItems.map(i => `<li class="list-group-item d-flex justify-content-between px-0 bg-transparent"><span>${escapeHtml(i[0])}</span> <span><span class="fw-bold text-dark">${i[1].qty}</span> بار/عدد (<span class="text-muted">${formatPrice(i[1].revenue)} تومان</span>)</span></li>`).join('') : '<li class="list-group-item px-0 bg-transparent text-muted">موردی ثبت نشده است</li>'}
                </ul>
            </div>
        `;
        document.getElementById('reportActionBtns').style.setProperty('display', 'flex', 'important');
    } 
    else if (activeSubTab === 'devices') {
        const timerDevices = localMenu.filter(m => m.is_timer);
        let deviceStats = {};
        timerDevices.forEach(d => { deviceStats[d.name] = { minutes: 0, revenue: 0, count: 0 }; });

        orders.forEach(o => {
            (o.items || []).forEach(i => {
                if (i.type === 'timer' || i.hourly_rate) {
                    const dName = i.device_name || i.name.replace('بازی ', '');
                    if (!deviceStats[dName]) deviceStats[dName] = { minutes: 0, revenue: 0, count: 0 };
                    deviceStats[dName].minutes += (i.duration_mins || 0);
                    deviceStats[dName].revenue += (i.price || 0);
                    deviceStats[dName].count++;
                }
            });
        });

        document.getElementById('deviceReportContent').innerHTML = `
            <div class="row g-3 mt-2">
                ${Object.entries(deviceStats).map(([name, stat]) => `
                    <div class="col-12 col-md-6">
                        <div class="card-modern">
                            <h6 class="fw-bold text-primary"><i class="fas fa-gamepad me-1"></i> ${escapeHtml(name)}</h6>
                            <div class="d-flex justify-content-between small border-bottom py-2"><span>تعداد دفعات استفاده:</span> <strong>${stat.count} بار</strong></div>
                            <div class="d-flex justify-content-between small border-bottom py-2"><span>مجموع زمان کارکرد:</span> <strong>${stat.minutes} دقیقه (${(stat.minutes/60).toFixed(1)} ساعت)</strong></div>
                            <div class="d-flex justify-content-between small py-2 fs-6"><span>مجموع درآمد دستگاه:</span> <strong class="text-success">${formatPrice(stat.revenue)} تومان</strong></div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        document.getElementById('reportActionBtns').style.setProperty('display', 'none', 'important');
    } 
    else if (activeSubTab === 'logs') {
        document.getElementById('logReportContent').innerHTML = `
            <div class="table-responsive mt-3">
                <table class="log-table">
                    <thead>
                        <tr>
                            <th>تاریخ و زمان</th>
                            <th>کاربر / پرسنل</th>
                            <th>نوع رویداد</th>
                            <th>جزئیات رویداد</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${localLogs.length ? localLogs.map(l => {
                            const d = new Date(l.created_at);
                            const dateStr = d.toLocaleDateString('fa-IR') + ' - ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
                            return `
                                <tr>
                                    <td><small class="text-muted">${dateStr}</small></td>
                                    <td><strong>${escapeHtml(l.user_name)}</strong></td>
                                    <td><span class="badge bg-secondary">${escapeHtml(l.action)}</span></td>
                                    <td>${escapeHtml(l.details)}</td>
                                </tr>
                            `;
                        }).join('') : '<tr><td colspan="4" class="text-center text-muted py-3">هیچ رویدادی ثبت نشده است</td></tr>'}
                    </tbody>
                </table>
            </div>
        `;
        document.getElementById('reportActionBtns').style.setProperty('display', 'none', 'important');
    }
}

window.copyReportText = function() {
    const el = document.getElementById('printableReport');
    if (!el) return;
    const text = el.innerText.replace(/\n\s*\n/g, '\n');
    navigator.clipboard.writeText(text).then(() => toast('متن گزارش کپی شد')).catch(() => toast('خطا در کپی', 'danger'));
};

window.printReportHTML = function() {
    const el = document.getElementById('printableReport');
    if (!el) return;
    const pr = window.open('', '', 'height=600,width=800');
    pr.document.write(`<html dir="rtl"><head><title>چاپ گزارش</title><style>body{font-family:Vazir,Tahoma,Arial;font-size:14px;padding:20px;line-height:1.6;} .border-bottom{border-bottom:1px solid #ccc;padding-bottom:5px;margin-bottom:5px;} .d-flex{display:flex;justify-content:space-between;} .fw-bold{font-weight:bold;} ul{list-style:none;padding:0;}</style></head><body><h2>گزارش کافه کلاور</h2>${el.innerHTML}</body></html>`);
    pr.document.close();
    pr.focus();
    setTimeout(() => { pr.print(); pr.close(); }, 500);
};

// 10. SYSTEM & FULL PAGE CUSTOMER STATS DETAIL
function renderUsers() {
    document.getElementById('userList').innerHTML = localProfiles.map(u => `
        <div class="d-flex justify-content-between align-items-center border-bottom py-2">
            <div>
                <strong>${escapeHtml(u.full_name || 'بدون نام')}</strong>
                <span class="badge ${u.role === 'manager' ? 'bg-primary' : 'bg-secondary'} ms-1">${u.role === 'manager' ? 'مدیر' : 'کارمند'}</span>
                <div class="text-muted small">ایمیل: ${escapeHtml(u.email)}</div>
            </div>
        </div>
    `).join('') || '<div class="empty-state">دیتای پرسنل لود نشد</div>';
}

document.getElementById('custSearch').addEventListener('input', renderCustomersList);

function renderCustomersList() {
    const sq = document.getElementById('custSearch').value.trim().toLowerCase();
    let stats = {};
    localOrders.forEach(o => {
        if (o.status !== 'لغو' && o.status !== 'معلق') {
            if (!stats[o.customer_name]) stats[o.customer_name] = { count: 0, spent: 0 };
            stats[o.customer_name].count++;
            stats[o.customer_name].spent += (o.total || 0);
        }
    });

    let filtered = localCustomers;
    if (sq) filtered = filtered.filter(c => c.full_name.toLowerCase().includes(sq));

    document.getElementById('customerListTable').innerHTML = filtered.length ? filtered.map(c => {
        const s = stats[c.full_name] || { count: 0, spent: 0 };
        return `
            <div class="border-bottom py-3 d-flex justify-content-between align-items-center">
                <div>
                    <strong class="fs-6 text-dark">${escapeHtml(c.full_name)}</strong>
                    <div class="small mt-1 text-muted"><i class="fas fa-shopping-bag me-1"></i> ${s.count} فاکتور تسویه شده | <i class="fas fa-coins me-1"></i> ${formatPrice(s.spent)} تومان خرید</div>
                </div>
                <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-primary-custom" data-name="${escapeHtml(c.full_name)}" onclick="viewCustomerStats(this.dataset.name)"><i class="fas fa-chart-line me-1"></i> آمار کامل</button>
                    <button class="btn btn-sm btn-outline-secondary" data-name="${escapeHtml(c.full_name)}" onclick="editCustomer(this.dataset.name)"><i class="fas fa-edit"></i> ویرایش</button>
                </div>
            </div>
        `;
    }).join('') : '<div class="empty-state">مشتری یافت نشد</div>';
}

// FULL PAGE CUSTOMER STATS RENDERER
window.viewCustomerStats = function(custName) {
    const custOrders = localOrders.filter(o => o.customer_name === custName && o.status !== 'لغو');
    const settledOrders = custOrders.filter(o => o.status !== 'معلق');
    
    let totalSpent = 0;
    let totalTimerMins = 0;
    let itemsPurchasedMap = {};

    settledOrders.forEach(o => {
        totalSpent += (o.total || 0);
        (o.items || []).forEach(i => {
            if (i.type === 'timer' || i.hourly_rate) {
                totalTimerMins += (i.duration_mins || 0);
            } else {
                itemsPurchasedMap[i.name] = (itemsPurchasedMap[i.name] || 0) + (i.qty || 1);
            }
        });
    });

    const itemsSummaryHTML = Object.entries(itemsPurchasedMap).map(([name, qty]) => `
        <div class="d-flex justify-content-between border-bottom py-2 small">
            <span>${escapeHtml(name)}</span>
            <span class="fw-bold">${qty} عدد</span>
        </div>
    `).join('') || '<div class="text-muted small py-2">هیچ کالا ثابتی خریداری نشده است</div>';

    const historyOrdersHTML = custOrders.map(o => {
        const d = new Date(o.created_at);
        const dateStr = d.toLocaleDateString('fa-IR') + ' - ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="border-bottom py-2 small">
                <div class="d-flex justify-content-between mb-1">
                    <span>#${o.id} - ${dateStr}</span>
                    <span class="fw-bold text-success">${formatPrice(o.total)} تومان</span>
                </div>
                <div class="d-flex justify-content-between align-items-center">
                    <span class="text-muted">ثبت: ${escapeHtml(o.created_by || '-')} | تسویه: ${escapeHtml(o.settled_by || '-')}</span>
                    <span class="badge ${o.status==='نقدی'?'bg-success':o.status==='کارت'?'bg-info':'bg-warning'}">${escapeHtml(o.status)}</span>
                </div>
            </div>
        `;
    }).join('') || '<div class="empty-state">سفارشی برای این مشتری وجود ندارد</div>';

    document.getElementById('custPageTitle').innerHTML = `<i class="fas fa-user-circle me-1"></i> آمار کامل مشتری: <strong>${escapeHtml(custName)}</strong>`;
    document.getElementById('custDetailPageBody').innerHTML = `
        <div class="card-modern mb-3">
            <div class="row g-2 text-center">
                <div class="col-4"><div class="stat-card p-2"><div class="fs-5 font-weight-bold text-primary">${settledOrders.length}</div><small>فاکتور تسویه شده</small></div></div>
                <div class="col-4"><div class="stat-card p-2"><div class="fs-5 font-weight-bold text-success">${formatPrice(totalSpent)} ت</div><small>مجموع خرید</small></div></div>
                <div class="col-4"><div class="stat-card p-2"><div class="fs-5 font-weight-bold text-warning">${totalTimerMins} دقیقه</div><small>بازی روی دستگاه‌ها</small></div></div>
            </div>
        </div>

        <div class="row g-3">
            <div class="col-12 col-md-5">
                <div class="card-modern h-100">
                    <h6 class="fw-bold text-dark border-bottom pb-2 mb-3"><i class="fas fa-utensils text-info me-1"></i> خلاصه خریدهای بوفه:</h6>
                    <div>${itemsSummaryHTML}</div>
                </div>
            </div>
            <div class="col-12 col-md-7">
                <div class="card-modern h-100">
                    <h6 class="fw-bold text-dark border-bottom pb-2 mb-3"><i class="fas fa-history text-primary me-1"></i> تاریخچه کامل فاکتورها و بازی‌ها:</h6>
                    <div>${historyOrdersHTML}</div>
                </div>
            </div>
        </div>
    `;

    showPage('customer-detail');
};

window.editCustomer = async function(oldName) {
    const newName = await showInputModal('ویرایش نام مشتری', 'نام جدید مشتری را وارد کنید:', oldName);
    if (!newName || newName === oldName) return;
    uiLoading(true);
    try {
        const check = localCustomers.find(c => c.full_name === newName);
        if (check) { toast('این نام از قبل وجود دارد', 'danger'); return; }

        const { error: err1 } = await supa.from('customers').update({ full_name: newName }).eq('full_name', oldName);
        if (err1) throw err1;
        const { error: err2 } = await supa.from('orders').update({ customer_name: newName }).eq('customer_name', oldName);
        if (err2) throw err2;

        toast('مشخصات مشتری با موفقیت ویرایش شد');
        logSystemAction('ویرایش مشتری', `تغییر نام مشتری از ${oldName} به ${newName}`);
        await silentRefreshData();
        broadcastGlobalSync();
    } catch (err) {
        console.error('Edit customer error:', err);
        toast('خطا در ویرایش اطلاعات مشتری', 'danger');
    } finally {
        uiLoading(false);
    }
};

document.addEventListener('DOMContentLoaded', initApp);
