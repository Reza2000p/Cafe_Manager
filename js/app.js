// ==========================================
// CAFE CLOVER - APPLICATION LOGIC (APP.JS)
// ==========================================

// AUTO SERVICE WORKER REGISTRATION & FORCE UPDATE CHECK
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=20260804_v7').then(reg => {
            reg.update(); // Force check for SW update on every load
        }).catch(err => console.log('SW registration error:', err));
    });
}

// CUSTOM BOOTSTRAP MODALS (REPLACING BROWSER CONFIRM & PROMPT)
function showConfirmModal(title, text) {
    return new Promise((resolve) => {
        document.getElementById('confirmModalTitle').textContent = title || 'تأیید عملیات';
        document.getElementById('confirmModalBody').textContent = text || 'آیا مطمئن هستید؟';
        const modalEl = document.getElementById('confirmModal');
        const modal = new bootstrap.Modal(modalEl);
        const actionBtn = document.getElementById('confirmModalActionBtn');
        let confirmed = false;
        
        const onConfirm = () => {
            confirmed = true;
            if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
            modal.hide();
        };

        const onHidden = () => {
            actionBtn.removeEventListener('click', onConfirm);
            modalEl.removeEventListener('hidden.bs.modal', onHidden);
            resolve(confirmed);
        };
        
        actionBtn.addEventListener('click', onConfirm, { once: true });
        modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
        modal.show();
    });
}

function showInputModal(title, label, defaultValue = '') {
    return new Promise((resolve) => {
        document.getElementById('inputModalTitle').textContent = title || 'ورود اطلاعات';
        document.getElementById('inputModalLabel').textContent = label || 'مقدار:';
        const inputEl = document.getElementById('inputModalValue');
        inputEl.value = defaultValue;
        
        const modalEl = document.getElementById('inputModal');
        const modal = new bootstrap.Modal(modalEl);
        const actionBtn = document.getElementById('inputModalActionBtn');
        let resultValue = null;
        
        const onConfirm = () => {
            const val = inputEl.value;
            resultValue = val ? val.trim() : null;
            if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
            modal.hide();
        };

        const onHidden = () => {
            actionBtn.removeEventListener('click', onConfirm);
            modalEl.removeEventListener('hidden.bs.modal', onHidden);
            resolve(resultValue);
        };
        
        actionBtn.addEventListener('click', onConfirm, { once: true });
        modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
        modal.show();
    });
}

// 1. INITIALIZATION & AUTH
async function initApp() {
    uiLoading(true);
    try {
        const client = (typeof getSupa === 'function') ? getSupa() : supa;
        if (!client) {
            showPage('login');
            uiLoading(false);
            return;
        }
        const { data: { session }, error } = await client.auth.getSession();
        if (error) throw error;

        if (session) {
            currentUser = session.user;
            await loadInitialData();
            document.getElementById('logoutBtn').style.display = 'inline';
            const savedPage = localStorage.getItem('cafe_active_page') || 'dashboard';
            showPage(savedPage);
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

    const activeClient = (typeof getSupa === 'function') ? getSupa() : supa;
    if (activeClient) {
        activeClient.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_OUT') {
                currentUser = null;
                userProfile = null;
                if (realtimePollingInterval) {
                    clearInterval(realtimePollingInterval);
                    realtimePollingInterval = null;
                }
                if (globalChannel) {
                    try { activeClient.removeChannel(globalChannel); } catch(e){}
                    globalChannel = null;
                }
                document.getElementById('logoutBtn').style.display = 'none';
                showPage('login');
            }
        });
    }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    uiLoading(true);
    try {
        const client = (typeof getSupa === 'function') ? getSupa() : supa;
        if (!client) {
            toast('ارتباط با کلاینت دیتابیس (Supabase) برقرار نشد. لطفاً اتصال اینترنت خود را بررسی کنید یا صفحه را رفرش فرمایید.', 'danger');
            uiLoading(false);
            return;
        }
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value.trim();
        const { data, error } = await client.auth.signInWithPassword({ email, password });
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
            supa.from('orders').select('*').order('created_at', { ascending: false }).limit(200),
            supa.from('profiles').select('*'),
            supa.from('customers').select('*').order('created_at', { ascending: false }).limit(100),
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

// SILENT REFRESH DATA (SMART PAYLOAD OPTIMIZATION & DEBOUNCE)
let isRefreshingSilently = false;
let refreshDebounceTimer = null;

function debouncedSilentRefresh(fullRefresh = false) {
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
        silentRefreshData(fullRefresh);
    }, 300);
}

async function silentRefreshData(fullRefresh = false) {
    if (isRefreshingSilently || !currentUser) return;
    isRefreshingSilently = true;
    try {
        const activePage = document.querySelector('.page.active')?.id;
        const isReports = activePage === 'page-reports';
        const isSystem = activePage === 'page-system';

        let promises = [
            supa.from('orders').select('*').order('created_at', { ascending: false }).limit(2000),
            supa.from('active_timer_sessions').select('*')
        ];

        if (fullRefresh || isReports || isSystem) {
            promises.push(
                supa.from('menu_items').select('*'),
                supa.from('categories').select('*'),
                supa.from('customers').select('*').order('created_at', { ascending: false }).limit(1000),
                supa.from('system_logs').select('*').order('created_at', { ascending: false }).limit(2000),
                supa.from('profiles').select('*')
            );
        }

        const results = await Promise.all(promises);
        
        const ordersRes = results[0];
        const activeSessionsRes = results[1];

        if (ordersRes && ordersRes.data) localOrders = ordersRes.data;
        if (activeSessionsRes && activeSessionsRes.data && !activeSessionsRes.error) parseSupabaseActiveSessions(activeSessionsRes.data);

        if (fullRefresh || isReports || isSystem) {
            const menuRes = results[2];
            const catsRes = results[3];
            const custRes = results[4];
            const logsRes = results[5];
            const profilesRes = results[6];

            if (menuRes && menuRes.data) localMenu = menuRes.data;
            if (catsRes && catsRes.data) localCats = catsRes.data;
            if (custRes && custRes.data) localCustomers = custRes.data;
            if (logsRes && logsRes.data) localLogs = logsRes.data;
            if (profilesRes && profilesRes.data) {
                localProfiles = profilesRes.data;
                populateFilters();
            }
        }

        // SILENTLY RE-RENDER ACTIVE VIEW
        if (activePage === 'page-orders') {
            const activeOrderTab = document.querySelector('#orderTabs .nav-link.active')?.dataset?.tab;
            if (activeOrderTab === 'timers' && typeof renderLiveDevices === 'function') renderLiveDevices();
            if (activeOrderTab === 'settle' && typeof renderSettlement === 'function') renderSettlement();
            if (activeOrderTab === 'history' && typeof renderHistory === 'function') renderHistory();
        } else if (activePage === 'page-dashboard') {
            if (typeof renderDashboard === 'function') renderDashboard();
        } else if (activePage === 'page-menu') {
            if (typeof renderMenu === 'function') renderMenu();
        } else if (activePage === 'page-reports') {
            if (typeof renderReports === 'function') renderReports();
        } else if (activePage === 'page-system') {
            if (typeof renderUsers === 'function') renderUsers();
            if (typeof renderCustomersList === 'function') renderCustomersList();
        }
    } catch(e) {
        console.error('Silent refresh error:', e);
    } finally {
        isRefreshingSilently = false;
    }
}

// BROADCAST SIGNAL TO ALL CONNECTED CLIENTS (INSTANT SYNC)
let globalChannel = null;
let realtimePollingInterval = null;

function broadcastGlobalSync() {
    if (globalChannel) {
        try {
            globalChannel.send({
                type: 'broadcast',
                event: 'sync_all',
                payload: { timestamp: Date.now() }
            });
        } catch(e){}
    }
}

function initRealtime() {
    if (!supa) return;
    
    if (globalChannel) {
        try { supa.removeChannel(globalChannel); } catch(e){}
    }
    
    globalChannel = supa.channel('global-cafe-channel');

    // 1. Listen to Supabase Postgres DB Table Changes & Broadcast Signals (Instant sync across all devices)
    globalChannel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'active_timer_sessions' }, () => {
            debouncedSilentRefresh(false);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
            debouncedSilentRefresh(false);
        })
        .on('broadcast', { event: 'sync_all' }, () => {
            debouncedSilentRefresh(false);
        });

    globalChannel.subscribe();

    // 2. Fallback Polling (Every 15 Seconds) as background safety net
    if (realtimePollingInterval) clearInterval(realtimePollingInterval);
    realtimePollingInterval = setInterval(async () => {
        if (currentUser) {
            debouncedSilentRefresh(false);
        }
    }, 45000);
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
    const profileNames = localProfiles.map(p => p.full_name).filter(Boolean);
    const logNames = localLogs.map(l => l.user_name).filter(Boolean);
    const uniqueUsers = [...new Set([...profileNames, ...logNames])];
    const opts = '<option value="">همه پرسنل</option>' + uniqueUsers.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');
    
    ['histCreatedUserFilter', 'histSettledUserFilter', 'reportLogUserFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const currentVal = el.value;
            el.innerHTML = opts;
            if (currentVal && uniqueUsers.includes(currentVal)) {
                el.value = currentVal;
            }
        }
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

    const timerMenuFilter = document.getElementById('timerMenuCatFilter');
    if (timerMenuFilter) {
        timerMenuFilter.innerHTML = `<option value="">همه دسته‌های تایمری</option>` + timerCats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    }
}

// 3. NAVIGATION & TABS
function restoreSubTab(navId, contentId) {
    const savedSubTab = localStorage.getItem(`cafe_subtab_${navId}`);
    if (savedSubTab) {
        const tabBtn = document.querySelector(`#${navId} .nav-link[data-tab="${savedSubTab}"]`);
        if (tabBtn && !tabBtn.classList.contains('active')) {
            tabBtn.click();
        }
    }
}

function showPage(page) {
    if (!currentUser && page !== 'login') return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const targetPage = document.getElementById(`page-${page}`);
    if (targetPage) targetPage.classList.add('active');

    document.querySelectorAll('.bottom-nav .nav-item, .desktop-nav .nav-item').forEach(b => {
        b.classList.toggle('active', b.dataset.page === page);
    });

    if (page !== 'login') {
        try { localStorage.setItem('cafe_active_page', page); } catch(e){}
        if (page === 'dashboard') renderDashboard();
        if (page === 'menu') {
            restoreSubTab('menuTabs', 'menuTabContent');
            restoreSubTab('catSubTabs', 'catSubTabContent');
            renderMenu(); renderCats(); populateCatSelects();
        }
        if (page === 'orders') {
            restoreSubTab('orderTabs', 'orderTabContent');
            restoreSubTab('historySubTabs', 'historySubTabContent');
            renderOrdersTab(); renderSettlement();
        }
        if (page === 'reports') {
            populateFilters();
            restoreSubTab('reportSubTabs', 'reportSubTabContent');
            renderReports();
        }
        if (page === 'system') {
            restoreSubTab('systemTabs', 'systemTabContent');
            renderUsers(); renderCustomersList();
        }
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
            try { localStorage.setItem(`cafe_subtab_${navId}`, this.dataset.tab); } catch(e){}
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

    const tmSearch = document.getElementById('timerMenuSearch');
    const tmCat = document.getElementById('timerMenuCatFilter');
    if (tmSearch) tmSearch.addEventListener('input', renderMenu);
    if (tmCat) tmCat.addEventListener('change', renderMenu);
});

// 4. DASHBOARD
document.getElementById('dashTimeFilter').addEventListener('change', renderDashboard);

function renderDashboard() {
    const timeFilter = document.getElementById('dashTimeFilter').value;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    let targetOrders = localOrders.filter(o => o.status !== 'لغو');

    if (timeFilter === 'today') {
        targetOrders = targetOrders.filter(o => new Date(o.created_at) >= startOfToday);
    } else if (timeFilter === 'yesterday') {
        const startOfYesterday = new Date(startOfToday);
        startOfYesterday.setDate(startOfYesterday.getDate() - 1);
        targetOrders = targetOrders.filter(o => {
            const d = new Date(o.created_at);
            return d >= startOfYesterday && d < startOfToday;
        });
    } else if (timeFilter === '3days' || timeFilter === 'week' || timeFilter === 'month') {
        const limitDate = new Date(startOfToday);
        limitDate.setDate(limitDate.getDate() - (timeFilter === '3days' ? 2 : (timeFilter === 'week' ? 6 : 29)));
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
function sortMenuItemsByCategory(items) {
    const catOrderMap = {};
    localCats.forEach((cat, index) => {
        catOrderMap[cat.name] = index;
    });
    return items.slice().sort((a, b) => {
        const orderA = catOrderMap[a.cat] !== undefined ? catOrderMap[a.cat] : 9999;
        const orderB = catOrderMap[b.cat] !== undefined ? catOrderMap[b.cat] : 9999;
        if (orderA !== orderB) return orderA - orderB;

        const displayOrderA = Number(a.display_order || 0);
        const displayOrderB = Number(b.display_order || 0);
        if (displayOrderA !== displayOrderB) return displayOrderA - displayOrderB;

        return (a.name || '').localeCompare(b.name || '', 'fa');
    });
}

function renderMenu() {
    const q = (document.getElementById('menuSearch')?.value || '').trim().toLowerCase();
    const c = document.getElementById('menuCatFilter')?.value || '';

    const tQ = (document.getElementById('timerMenuSearch')?.value || '').trim().toLowerCase();
    const tC = document.getElementById('timerMenuCatFilter')?.value || '';

    let staticItems = localMenu.filter(it => !it.is_timer && it.name.toLowerCase().includes(q) && (c ? it.cat === c : true));
    let timerDevices = localMenu.filter(it => it.is_timer && it.name.toLowerCase().includes(tQ) && (tC ? it.cat === tC : true));

    staticItems = sortMenuItemsByCategory(staticItems);
    timerDevices = sortMenuItemsByCategory(timerDevices);

    // Render Static Items Tab
    document.getElementById('staticMenuList').innerHTML = staticItems.length ? staticItems.map(it => `
        <div class="d-flex justify-content-between align-items-center border-bottom py-3">
            <div style="flex:1; min-width:0;" class="pe-2">
                <strong class="fs-6">${escapeHtml(it.name)}</strong>
                <span class="badge bg-light text-dark ms-2 border">${escapeHtml(it.cat)}</span>
                ${it.is_game ? `<span class="badge bg-primary-subtle text-primary border border-primary-subtle rounded-pill ms-1" style="font-size:0.75rem;"><i class="fas fa-gamepad me-1"></i>گیم و بازی</span>` : ''}
                <span class="badge bg-secondary ms-1">ترتیب: ${it.display_order || 0}</span>
                <div class="text-primary fw-bold mt-1">${formatPrice(it.price)} تومان</div>
            </div>
            <div style="flex-shrink:0;" class="d-flex align-items-center gap-1 me-2">
                <button class="btn btn-sm btn-outline-warning" onclick="editMenu(${it.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteMenu(${it.id})"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('') : '<div class="empty-state">آیتم ثابتی یافت نشد</div>';

    // Render Timer Devices Tab
    document.getElementById('timerMenuList').innerHTML = timerDevices.length ? timerDevices.map(it => {
        const isVar = it.rate_type === 'variable';
        let rateDisplay = '';
        if (isVar && it.tiered_rates && typeof it.tiered_rates === 'object') {
            rateDisplay = Object.entries(it.tiered_rates).map(([k, v]) => `${k}نفره: ${formatPrice(v)}ت`).join(' | ');
            rateDisplay = `نرخ متغیر: ${rateDisplay}`;
        } else {
            rateDisplay = `نرخ ثابت (نفری): ${formatPrice(it.hourly_rate || it.price)} تومان/ساعت`;
        }

        return `
            <div class="d-flex justify-content-between align-items-center border-bottom py-3">
                <div style="flex:1; min-width:0;" class="pe-2">
                    <strong class="fs-6"><i class="fas fa-gamepad text-warning me-1"></i> ${escapeHtml(it.name)}</strong>
                    <span class="badge bg-light text-dark ms-2 border">${escapeHtml(it.cat)}</span>
                    <span class="badge bg-secondary ms-1">ترتیب: ${it.display_order || 0}</span>
                    <div class="text-success fw-bold mt-1 small" style="white-space:normal; word-break:break-word;">${rateDisplay}</div>
                </div>
                <div style="flex-shrink:0;" class="d-flex align-items-center gap-1 me-2">
                    <button class="btn btn-sm btn-outline-warning" onclick="editMenu(${it.id})"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteMenu(${it.id})"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join('') : '<div class="empty-state">دستگاه تایمری یافت نشد</div>';
}

document.getElementById('menuSearch').addEventListener('input', renderMenu);
document.getElementById('menuCatFilter').addEventListener('change', renderMenu);

const rateTypeSelect = document.getElementById('menuFormRateType');
if (rateTypeSelect) {
    rateTypeSelect.addEventListener('change', () => {
        const isVar = rateTypeSelect.value === 'variable';
        document.getElementById('tieredRateContainer').style.display = isVar ? 'block' : 'none';
        document.getElementById('fixedRateContainer').style.display = isVar ? 'none' : 'block';
    });
}

document.getElementById('addStaticItemBtn').addEventListener('click', () => {
    populateCatSelects(false);
    document.getElementById('menuFormId').value = '';
    document.getElementById('menuFormIsTimer').value = 'false';
    document.getElementById('menuModalTitle').textContent = 'افزودن آیتم ثابت (بوفه)';
    document.getElementById('priceLabel').textContent = 'قیمت ثابت (تومان)';
    document.getElementById('menuFormName').value = '';
    document.getElementById('menuFormPrice').value = '';
    document.getElementById('menuFormDisplayOrder').value = '0';
    if (document.getElementById('menuFormIsGame')) document.getElementById('menuFormIsGame').checked = false;
    document.getElementById('rateTypeContainer').style.display = 'none';
    document.getElementById('tieredRateContainer').style.display = 'none';
    document.getElementById('fixedRateContainer').style.display = 'block';
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
    document.getElementById('menuFormDisplayOrder').value = '0';
    if (document.getElementById('menuFormIsGame')) document.getElementById('menuFormIsGame').checked = true;
    
    document.getElementById('rateTypeContainer').style.display = 'block';
    document.getElementById('menuFormRateType').value = 'fixed';
    document.getElementById('tieredRateContainer').style.display = 'none';
    document.getElementById('fixedRateContainer').style.display = 'block';
    
    ['tierRate1', 'tierRate2', 'tierRate3', 'tierRate4'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    new bootstrap.Modal(document.getElementById('menuModal')).show();
});

window.editMenu = function(id) {
    const item = localMenu.find(i => i.id === id);
    if (!item) return;
    populateCatSelects(item.is_timer);
    
    const setVal = (elId, val) => {
        const el = document.getElementById(elId);
        if (el) el.value = val !== undefined && val !== null ? val : '';
    };

    setVal('menuFormId', id);
    setVal('menuFormIsTimer', item.is_timer ? 'true' : 'false');
    const modalTitle = document.getElementById('menuModalTitle');
    if (modalTitle) modalTitle.textContent = item.is_timer ? 'ویرایش دستگاه تایمری' : 'ویرایش آیتم ثابت';
    const priceLabel = document.getElementById('priceLabel');
    if (priceLabel) priceLabel.textContent = item.is_timer ? 'نرخ هر ۱ ساعت (تومان)' : 'قیمت ثابت (تومان)';
    setVal('menuFormName', item.name);
    setVal('menuFormPrice', item.is_timer ? (item.hourly_rate || item.price) : item.price);
    setVal('menuFormCat', item.cat || '');
    setVal('menuFormDisplayOrder', item.display_order !== undefined ? item.display_order : 0);
    if (document.getElementById('menuFormIsGame')) {
        document.getElementById('menuFormIsGame').checked = item.is_timer || Boolean(item.is_game);
    }

    const rateTypeContainer = document.getElementById('rateTypeContainer');
    const tieredRateContainer = document.getElementById('tieredRateContainer');
    const fixedRateContainer = document.getElementById('fixedRateContainer');

    if (item.is_timer) {
        if (rateTypeContainer) rateTypeContainer.style.display = 'block';
        const rateType = item.rate_type || 'fixed';
        setVal('menuFormRateType', rateType);
        const isVar = rateType === 'variable';
        if (tieredRateContainer) tieredRateContainer.style.display = isVar ? 'block' : 'none';
        if (fixedRateContainer) fixedRateContainer.style.display = isVar ? 'none' : 'block';

        if (isVar && item.tiered_rates) {
            setVal('tierRate1', item.tiered_rates['1'] || '');
            setVal('tierRate2', item.tiered_rates['2'] || '');
            setVal('tierRate3', item.tiered_rates['3'] || '');
            setVal('tierRate4', item.tiered_rates['4'] || '');
        } else {
            ['tierRate1', 'tierRate2', 'tierRate3', 'tierRate4'].forEach(tid => setVal(tid, ''));
        }
    } else {
        if (rateTypeContainer) rateTypeContainer.style.display = 'none';
        if (tieredRateContainer) tieredRateContainer.style.display = 'none';
        if (fixedRateContainer) fixedRateContainer.style.display = 'block';
    }

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
    const getValStr = (elId) => {
        const el = document.getElementById(elId);
        return el ? el.value.trim() : '';
    };
    const getValInt = (elId) => {
        const el = document.getElementById(elId);
        return el ? (parseInt(el.value) || 0) : 0;
    };

    const id = getValStr('menuFormId');
    const isTimer = getValStr('menuFormIsTimer') === 'true';
    const name = getValStr('menuFormName');
    const cat = getValStr('menuFormCat');
    const displayOrder = getValInt('menuFormDisplayOrder');

    let price = getValInt('menuFormPrice');
    let rateType = 'fixed';
    let tieredRates = null;

    if (isTimer) {
        rateType = getValStr('menuFormRateType') || 'fixed';
        if (rateType === 'variable') {
            tieredRates = {
                "1": getValInt('tierRate1'),
                "2": getValInt('tierRate2'),
                "3": getValInt('tierRate3'),
                "4": getValInt('tierRate4')
            };
            price = tieredRates["1"] || 0;
        }
    }

    if (!name) {
        toast('نام آیتم/دستگاه الزامی است', 'danger');
        return;
    }

    if (rateType === 'fixed' && (isNaN(price) || price < 0)) {
        toast('مبلغ نامعتبر است', 'danger');
        return;
    }

    const isGame = isTimer ? true : Boolean(document.getElementById('menuFormIsGame')?.checked);

    uiLoading(true);
    try {
        const payload = { 
            name, 
            cat, 
            price: price || 0, 
            is_timer: isTimer, 
            hourly_rate: isTimer ? (price || 0) : 0,
            rate_type: isTimer ? rateType : 'fixed',
            tiered_rates: isTimer && rateType === 'variable' ? tieredRates : null,
            display_order: displayOrder,
            is_game: isGame
        };
        
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
        const catItem = localCats.find(c => c.id === id);
        const { error } = await supa.from('categories').delete().eq('id', id);
        if (error) throw error;
        toast('دسته حذف شد');
        logSystemAction('حذف دسته‌بندی', `حذف دسته ${catItem ? catItem.name : id}`);
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
    else cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, type: 'static', is_game: Boolean(item.is_game) });
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
        await ensureCustomerExists(custName);
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
        
        const isGameItem = (i) => {
            if (i.type === 'timer' || i.hourly_rate || i.is_game) return true;
            const match = localMenu.find(m => (m.id && String(m.id) === String(i.id)) || (m.name && m.name.trim().toLowerCase() === (i.name || '').trim().toLowerCase()));
            return Boolean(match && match.is_game);
        };
        const timerItems = g.items.filter(i => isGameItem(i));
        const staticItems = g.items.filter(i => !isGameItem(i));

        let timerRows = timerItems.map(t => {
            let timeRange = '';
            const sTime = t.start_time_str || (t.start_time ? new Date(t.start_time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '');
            const eTime = t.end_time_str || (t.end_time ? new Date(t.end_time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '');
            if (sTime && eTime) {
                timeRange = ` (از ${sTime} تا ${eTime})`;
            }

            const isStaticGame = t.type !== 'timer' && !t.hourly_rate;
            const itemLabel = isStaticGame ? `${escapeHtml(t.name)} (x${t.qty || 1})` : `${escapeHtml(t.name || t.device_name)}${timeRange} - ${t.duration_mins || 0} دقیقه`;
            const itemPrice = isStaticGame ? (t.price || 0) * (t.qty || 1) : t.price;

            return `
                <div class="invoice-item-row">
                    <span><i class="fas fa-gamepad text-warning me-1"></i> ${itemLabel}</span>
                    <span class="fw-bold">${formatPrice(itemPrice)} تومان</span>
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
            <div class="invoice-card position-relative">
                <button class="btn btn-sm btn-outline-danger border-0 position-absolute" style="top:12px;left:12px;width:28px;height:28px;padding:0;line-height:1;border-radius:50%;" title="لغو سفارشات" onclick='settleCustomerGroup(${idsJson}, "لغو", "${escapeHtml(custName)}")'><i class="fas fa-times"></i></button>
                <div class="invoice-header pe-4">
                    <div>
                        <strong class="fs-5 text-dark"><i class="fas fa-user-circle text-primary me-1"></i> ${escapeHtml(custName)}</strong>
                    </div>
                    <div class="text-end me-4">
                        <div class="fs-5 fw-bold text-success">${formatPrice(g.total)} تومان</div>
                        <small class="text-muted">${g.ids.length} فاکتور معلق</small>
                    </div>
                </div>

                <div class="invoice-details mb-3">
                    ${timerItems.length ? `<div class="invoice-section-title"><i class="fas fa-gamepad text-warning me-1"></i> ریز خدمات تایمری و ورودی بازی‌ها:</div>${timerRows}` : ''}
                    ${staticItems.length ? `<div class="invoice-section-title"><i class="fas fa-utensils text-info me-1"></i> ریز اقلام بوفه:</div>${staticRows}` : ''}
                    <div class="invoice-total-row">
                        <span>مجموع قابل پرداخت:</span>
                        <span>${formatPrice(g.total)} تومان</span>
                    </div>
                </div>

                <div class="d-flex gap-2">
                    <button class="btn btn-success-custom flex-fill py-2" onclick='settleCustomerGroup(${idsJson}, "نقدی", "${escapeHtml(custName)}")'><i class="fas fa-money-bill-wave me-1"></i> نقدی</button>
                    <button class="btn btn-primary-custom flex-fill py-2" onclick='settleCustomerGroup(${idsJson}, "کارت‌خوان", "${escapeHtml(custName)}")'><i class="fas fa-credit-card me-1"></i> کارت‌خوان</button>
                    <button class="btn btn-info text-white flex-fill py-2" style="background-color:#0dcaf0;border-color:#0dcaf0;" onclick='settleCustomerGroup(${idsJson}, "انتقال", "${escapeHtml(custName)}")'><i class="fas fa-exchange-alt me-1"></i> انتقال</button>
                </div>
            </div>
        `;
    }).join('');
}

window.settleCustomerGroup = async function(idsArray, method, customerName) {
    let confirmTitle = 'تأیید تسویه‌حساب';
    let confirmMsg = `آیا از ثبت تسویه‌حساب مشتری «${customerName}» به روش «${method}» اطمینان دارید؟`;
    if (method === 'لغو') {
        confirmTitle = 'تأیید لغو سفارشات';
        confirmMsg = `آیا تمامی سفارشات معلق مشتری «${customerName}» لغو و پاکسازی شوند؟`;
    }
    const confirmAction = await showConfirmModal(confirmTitle, confirmMsg);
    if (!confirmAction) return;

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

    const fromD = document.getElementById('histDateFrom')?.value;
    const toD = document.getElementById('histDateTo')?.value;

    let orders = localOrders.filter(o => o.status !== 'معلق');
    if (fromD) orders = orders.filter(o => new Date(o.created_at) >= new Date(fromD + 'T00:00:00'));
    if (toD) orders = orders.filter(o => new Date(o.created_at) <= new Date(toD + 'T23:59:59.999'));

    let csvContent = "\uFEFFشماره سفارش,مشتری,مبلغ (تومان),وضعیت,ثبت کننده,تسویه کننده,تاریخ و ساعت\n";
    orders.forEach(o => {
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

window.setHistDate = function(mode, btnEl) {
    if (btnEl) {
        document.querySelectorAll('#tab-history .quick-date-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
    const dFrom = document.getElementById('histDateFrom');
    const dTo = document.getElementById('histDateTo');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    if (mode === 'today') { dFrom.value = todayStr; dTo.value = todayStr; }
    else if (mode === 'yesterday') {
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        const yYear = yest.getFullYear();
        const yMonth = String(yest.getMonth() + 1).padStart(2, '0');
        const yDay = String(yest.getDate()).padStart(2, '0');
        const yestStr = `${yYear}-${yMonth}-${yDay}`;
        dFrom.value = yestStr; dTo.value = yestStr;
    }
    else if (mode === 'all') { dFrom.value = ''; dTo.value = ''; }
    else {
        const limit = new Date(now);
        if (mode === '3days') limit.setDate(limit.getDate() - 2);
        if (mode === 'week') limit.setDate(limit.getDate() - 6);
        const lYear = limit.getFullYear();
        const lMonth = String(limit.getMonth() + 1).padStart(2, '0');
        const lDay = String(limit.getDate()).padStart(2, '0');
        dFrom.value = `${lYear}-${lMonth}-${lDay}`;
        dTo.value = todayStr;
    }
    renderHistory();
};

function getPaymentStatusBadge(status) {
    const st = String(status || '').trim();
    if (st === 'نقدی') {
        return `<span class="badge bg-success ms-2"><i class="fas fa-money-bill-wave me-1"></i>نقدی</span>`;
    } else if (st === 'کارت‌خوان' || st === 'کارت') {
        return `<span class="badge bg-primary ms-2"><i class="fas fa-credit-card me-1"></i>کارت‌خوان</span>`;
    } else if (st === 'انتقال') {
        return `<span class="badge text-white ms-2" style="background-color:#0dcaf0;"><i class="fas fa-exchange-alt me-1"></i>انتقال</span>`;
    } else if (st === 'لغو' || st === 'لغو شده') {
        return `<span class="badge bg-danger ms-2"><i class="fas fa-times-circle me-1"></i>لغو شده</span>`;
    } else {
        return `<span class="badge bg-secondary ms-2">${escapeHtml(st || 'معلق')}</span>`;
    }
}

function renderHistoryOrderCard(o) {
    const d = new Date(o.created_at);
    const dateStr = d.toLocaleDateString('fa-IR') + ' - ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

    const timerItems = (o.items || []).filter(i => i.type === 'timer' || i.hourly_rate);
    const staticItems = (o.items || []).filter(i => i.type !== 'timer' && !i.hourly_rate);

    let timerRows = timerItems.map(t => {
        let timeRange = '';
        const sTime = t.start_time_str || (t.start_time ? new Date(t.start_time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '');
        const eTime = t.end_time_str || (t.end_time ? new Date(t.end_time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '');
        if (sTime && eTime) {
            timeRange = ` (از ${sTime} تا ${eTime})`;
        }
        return `
            <div class="d-flex justify-content-between align-items-center border-bottom border-light py-1 small">
                <span><i class="fas fa-gamepad text-warning me-1"></i> ${escapeHtml(t.name || t.device_name)}${timeRange} - ${t.duration_mins || 0} دقیقه</span>
                <span class="fw-bold text-dark">${formatPrice(t.price)} تومان</span>
            </div>
        `;
    }).join('');

    let staticRows = staticItems.map(s => `
        <div class="d-flex justify-content-between align-items-center border-bottom border-light py-1 small">
            <span><i class="fas fa-coffee text-info me-1"></i> ${escapeHtml(s.name)} (x${s.qty || 1})</span>
            <span class="fw-bold text-dark">${formatPrice((s.price || 0) * (s.qty || 1))} تومان</span>
        </div>
    `).join('');

    return `
        <div class="card-modern mb-2 p-3 border">
            <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-2">
                <div>
                    <strong class="fs-6 text-dark"><i class="fas fa-receipt text-primary me-1"></i> #${o.id} - ${escapeHtml(o.customer_name)}</strong>
                </div>
                <div class="text-end">
                    <span class="fw-bold text-success fs-6">${formatPrice(o.total)} تومان</span>
                    ${getPaymentStatusBadge(o.status)}
                </div>
            </div>

            ${(timerItems.length || staticItems.length) ? `
                <div class="bg-light p-2 rounded-3 mb-2">
                    ${timerItems.length ? `<div class="small fw-bold text-secondary mb-1"><i class="fas fa-stopwatch text-warning me-1"></i> ریز خدمات دستگاه‌ها:</div>${timerRows}` : ''}
                    ${staticItems.length ? `<div class="small fw-bold text-secondary mb-1 ${timerItems.length ? 'mt-2' : ''}"><i class="fas fa-utensils text-info me-1"></i> ریز اقلام بوفه:</div>${staticRows}` : ''}
                </div>
            ` : ''}

            <div class="d-flex justify-content-between align-items-center small text-muted">
                <div><i class="fas fa-clock me-1"></i> ${dateStr}</div>
                <div><i class="fas fa-user-edit me-1"></i> ثبت: <strong>${escapeHtml(o.created_by || 'نامشخص')}</strong> | <i class="fas fa-user-check me-1"></i> تسویه: <strong>${escapeHtml(o.settled_by || o.created_by || 'نامشخص')}</strong></div>
            </div>
        </div>
    `;
}

function filterHistoryByPaymentMethod(orders, payF) {
    if (!payF) return orders;
    return orders.filter(o => {
        const st = String(o.status || '').trim();
        if (payF === 'کارت‌خوان' || payF === 'کارت') {
            return st === 'کارت‌خوان' || st === 'کارت';
        }
        if (payF === 'لغو' || payF === 'لغو شده') {
            return st === 'لغو' || st === 'لغو شده';
        }
        return st === payF;
    });
}

function renderHistory() {
    const activeSubTab = document.querySelector('#historySubTabs .nav-link.active')?.dataset?.tab || 'created';
    const fromD = document.getElementById('histDateFrom')?.value;
    const toD = document.getElementById('histDateTo')?.value;

    if (activeSubTab === 'created') {
        const payF = document.getElementById('histCreatedPayFilter')?.value;
        const userF = document.getElementById('histCreatedUserFilter')?.value;

        let filtered = localOrders.filter(o => o.status !== 'معلق');
        filtered = filterHistoryByPaymentMethod(filtered, payF);
        if (userF) filtered = filtered.filter(o => o.created_by === userF);

        if (fromD) {
            const fromDate = new Date(fromD + 'T00:00:00');
            filtered = filtered.filter(o => new Date(o.created_at) >= fromDate);
        }
        if (toD) {
            const toDate = new Date(toD + 'T23:59:59.999');
            filtered = filtered.filter(o => new Date(o.created_at) <= toDate);
        }

        document.getElementById('historyCreatedList').innerHTML = filtered.length ? filtered.map(o => renderHistoryOrderCard(o)).join('') : '<div class="empty-state">سفارشی ثبت نشده است</div>';
    } else {
        const payF = document.getElementById('histSettledPayFilter')?.value;
        const userF = document.getElementById('histSettledUserFilter')?.value;

        let filtered = localOrders.filter(o => o.status !== 'معلق');
        filtered = filterHistoryByPaymentMethod(filtered, payF);
        if (userF) filtered = filtered.filter(o => o.settled_by === userF);

        if (fromD) {
            const fromDate = new Date(fromD + 'T00:00:00');
            filtered = filtered.filter(o => new Date(o.created_at) >= fromDate);
        }
        if (toD) {
            const toDate = new Date(toD + 'T23:59:59.999');
            filtered = filtered.filter(o => new Date(o.created_at) <= toDate);
        }

        document.getElementById('historySettledList').innerHTML = filtered.length ? filtered.map(o => renderHistoryOrderCard(o)).join('') : '<div class="empty-state">تسویه‌ای ثبت نشده است</div>';
    }
}

['histCreatedPayFilter', 'histCreatedUserFilter', 'histSettledPayFilter', 'histSettledUserFilter', 'reportLogUserFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
        if (id === 'reportLogUserFilter') renderReports();
        else renderHistory();
    });
});

document.addEventListener('DOMContentLoaded', () => {
    const applyBtn = document.getElementById('applyHistFilter');
    if (applyBtn) applyBtn.addEventListener('click', renderHistory);
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
    else if (mode === 'yesterday') {
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        const yYear = yest.getFullYear();
        const yMonth = String(yest.getMonth() + 1).padStart(2, '0');
        const yDay = String(yest.getDate()).padStart(2, '0');
        const yestStr = `${yYear}-${yMonth}-${yDay}`;
        dFrom.value = yestStr; dTo.value = yestStr;
    }
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
    const logUserF = document.getElementById('reportLogUserFilter')?.value || '';

    const actionBtns = document.getElementById('reportActionBtns');
    if (actionBtns) actionBtns.style.setProperty('display', 'flex', 'important');

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
        const totalCard = orders.filter(o => o.status === 'کارت‌خوان' || o.status === 'کارت').reduce((s, o) => s + (o.total || 0), 0);
        const totalTransfer = orders.filter(o => o.status === 'انتقال').reduce((s, o) => s + (o.total || 0), 0);

        let staticRev = 0;
        let timerRev = 0;

        let itemsMap = {};
        let devicesMap = {};

        orders.forEach(o => {
            (o.items || []).forEach(i => {
                const isGame = i.type === 'timer' || i.hourly_rate || i.is_game || Boolean(localMenu.find(m => (m.id && String(m.id) === String(i.id)) || (m.name && m.name.trim().toLowerCase() === (i.name || '').trim().toLowerCase()))?.is_game);
                if (isGame) {
                    const dName = i.device_name || i.name || 'بازی';
                    const itemRev = (i.price || 0) * (i.qty || 1);
                    timerRev += itemRev;
                    if (!devicesMap[dName]) devicesMap[dName] = { mins: 0, revenue: 0, count: 0 };
                    devicesMap[dName].mins += (i.duration_mins || 0);
                    devicesMap[dName].revenue += itemRev;
                    devicesMap[dName].count += (i.qty || 1);
                } else {
                    staticRev += (i.price || 0) * (i.qty || 1);
                    if (!itemsMap[i.name]) itemsMap[i.name] = { qty: 0, revenue: 0 };
                    itemsMap[i.name].qty += (i.qty || 1);
                    itemsMap[i.name].revenue += (i.price || 0) * (i.qty || 1);
                }
            });
        });

        const sortedItems = Object.entries(itemsMap).sort((a, b) => b[1].revenue - a[1].revenue);
        const sortedDevices = Object.entries(devicesMap).sort((a, b) => b[1].revenue - a[1].revenue);

        document.getElementById('salesReportContent').innerHTML = `
            <div id="printableReport" class="alert alert-light border shadow-sm mt-3" style="direction:rtl; text-align:right;">
                <h5 class="text-center text-primary mb-3 fw-bold">آمار دقیق فروش و کل درآمد</h5>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>فاکتورهای تسویه‌شده:</span> <strong>${orders.length} عدد</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>درآمد ثابت‌ها (بوفه):</span> <strong class="text-info">${formatPrice(staticRev)} تومان</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>درآمد تایمری‌ها (دستگاه‌ها):</span> <strong class="text-warning">${formatPrice(timerRev)} تومان</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>مجموع تسویه نقدی:</span> <strong class="text-success">${formatPrice(totalCash)} تومان</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>مجموع تسویه کارت‌خوان:</span> <strong class="text-primary">${formatPrice(totalCard)} تومان</strong></div>
                <div class="d-flex justify-content-between mb-2 border-bottom pb-2"><span>مجموع تسویه کارت‌به‌کارت / انتقال:</span> <strong style="color:#0dcaf0;">${formatPrice(totalTransfer)} تومان</strong></div>
                <div class="d-flex justify-content-between mt-3 fs-5 border-bottom pb-2 mb-3"><span>کل درآمد:</span> <strong class="text-primary">${formatPrice(totalRev)} تومان</strong></div>
                
                <h6 class="fw-bold mt-3 text-dark"><i class="fas fa-utensils text-info me-1"></i> پرفروش‌ترین اقلام بوفه (به ترتیب درآمد):</h6>
                <ul class="list-group list-group-flush small mb-3">
                    ${sortedItems.length ? sortedItems.map(i => `<li class="list-group-item d-flex justify-content-between px-0 bg-transparent"><span>${escapeHtml(i[0])} (${i[1].qty} عدد)</span> <span class="fw-bold text-success">${formatPrice(i[1].revenue)} تومان</span></li>`).join('') : '<li class="list-group-item px-0 bg-transparent text-muted">موردی ثبت نشده است</li>'}
                </ul>

                <h6 class="fw-bold mt-3 text-dark"><i class="fas fa-gamepad text-warning me-1"></i> پرکاربردترین دستگاه‌های بازی (به ترتیب درآمد):</h6>
                <ul class="list-group list-group-flush small">
                    ${sortedDevices.length ? sortedDevices.map(d => `<li class="list-group-item d-flex justify-content-between px-0 bg-transparent"><span>${escapeHtml(d[0])} (${d[1].count} بار - ${d[1].mins} دقیقه)</span> <span class="fw-bold text-success">${formatPrice(d[1].revenue)} تومان</span></li>`).join('') : '<li class="list-group-item px-0 bg-transparent text-muted">موردی ثبت نشده است</li>'}
                </ul>
            </div>
        `;
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

        const sortedDevStats = Object.entries(deviceStats).sort((a, b) => b[1].revenue - a[1].revenue);

        document.getElementById('deviceReportContent').innerHTML = `
            <div id="printableReport" class="row g-3 mt-2">
                ${sortedDevStats.map(([name, stat]) => `
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
    } 
    else if (activeSubTab === 'logs') {
        let logs = localLogs;
        if (fromD) {
            const fromDate = new Date(fromD + 'T00:00:00');
            logs = logs.filter(l => new Date(l.created_at) >= fromDate);
        }
        if (toD) {
            const toDate = new Date(toD + 'T23:59:59.999');
            logs = logs.filter(l => new Date(l.created_at) <= toDate);
        }
        if (logUserF) {
            logs = logs.filter(l => l.user_name === logUserF);
        }

        const totalLogs = logs.length;
        const totalPages = Math.ceil(totalLogs / logPageSize) || 1;
        if (logCurrentPage > totalPages) logCurrentPage = totalPages;
        if (logCurrentPage < 1) logCurrentPage = 1;

        const startIndex = (logCurrentPage - 1) * logPageSize;
        const paginatedLogs = logs.slice(startIndex, startIndex + logPageSize);

        let paginationHTML = '';
        if (totalPages > 1) {
            let pageBtns = '';
            for (let p = 1; p <= totalPages; p++) {
                if (p === 1 || p === totalPages || (p >= logCurrentPage - 1 && p <= logCurrentPage + 1)) {
                    pageBtns += `<button class="btn btn-sm ${p === logCurrentPage ? 'btn-primary' : 'btn-outline-secondary'} px-3" onclick="setLogPage(${p})">${p}</button>`;
                } else if (p === logCurrentPage - 2 || p === logCurrentPage + 2) {
                    pageBtns += `<span class="px-1 text-muted">...</span>`;
                }
            }

            paginationHTML = `
                <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top flex-wrap gap-2">
                    <div class="small text-muted">نمایش ${startIndex + 1} تا ${Math.min(startIndex + logPageSize, totalLogs)} از کل ${totalLogs} رویداد</div>
                    <div class="d-flex align-items-center gap-1">
                        <button class="btn btn-sm btn-outline-primary px-3" ${logCurrentPage === 1 ? 'disabled' : ''} onclick="setLogPage(${logCurrentPage - 1})"><i class="fas fa-chevron-right me-1"></i> قبلی</button>
                        ${pageBtns}
                        <button class="btn btn-sm btn-outline-primary px-3" ${logCurrentPage === totalPages ? 'disabled' : ''} onclick="setLogPage(${logCurrentPage + 1})">بعدی <i class="fas fa-chevron-left ms-1"></i></button>
                    </div>
                </div>
            `;
        }

        document.getElementById('logReportContent').innerHTML = `
            <div id="printableReport">
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
                            ${paginatedLogs.length ? paginatedLogs.map(l => {
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
                            }).join('') : '<tr><td colspan="4" class="text-center text-muted py-3">هیچ رویدادی در این بازه زمانی ثبت نشده است</td></tr>'}
                        </tbody>
                    </table>
                </div>
                ${paginationHTML}
            </div>
        `;
    }
}

let logCurrentPage = 1;
const logPageSize = 15;

function setLogPage(page) {
    logCurrentPage = page;
    renderReports();
}
window.setLogPage = setLogPage;

// EXPORT SYSTEM FOR REPORTS (PDF, CSV, TXT)
window.exportReportPDF = function() {
    const el = document.getElementById('printableReport');
    if (!el) { toast('گزارشی برای چاپ وجود ندارد', 'warning'); return; }
    const activeSubTab = document.querySelector('#reportSubTabs .nav-link.active')?.dataset?.tab || 'sales';
    const subTabName = activeSubTab === 'sales' ? 'فروش' : activeSubTab === 'devices' ? 'دستگاه‌ها' : 'رویدادها/لاگ‌ها';
    
    window.print();
    toast('صفحه چاپ / ذخیره PDF باز شد');
    logSystemAction('چاپ/PDF گزارش', `دریافت خروجی PDF از گزارش ${subTabName}`);
};

window.exportReportCSV = function() {
    const activeSubTab = document.querySelector('#reportSubTabs .nav-link.active')?.dataset?.tab || 'sales';
    const fromD = document.getElementById('reportDateFrom').value;
    const toD = document.getElementById('reportDateTo').value;
    const logUserF = document.getElementById('reportLogUserFilter')?.value || '';

    let csvContent = "\uFEFF"; // UTF-8 BOM for Excel

    if (activeSubTab === 'sales') {
        let orders = localOrders.filter(o => o.status !== 'معلق' && o.status !== 'لغو');
        if (fromD) orders = orders.filter(o => new Date(o.created_at) >= new Date(fromD + 'T00:00:00'));
        if (toD) orders = orders.filter(o => new Date(o.created_at) <= new Date(toD + 'T23:59:59.999'));

        const totalRev = orders.reduce((s, o) => s + (o.total || 0), 0);
        const totalCash = orders.filter(o => o.status === 'نقدی').reduce((s, o) => s + (o.total || 0), 0);
        const totalCard = orders.filter(o => o.status === 'کارت‌خوان' || o.status === 'کارت').reduce((s, o) => s + (o.total || 0), 0);
        const totalTransfer = orders.filter(o => o.status === 'انتقال').reduce((s, o) => s + (o.total || 0), 0);

        let staticRev = 0;
        let timerRev = 0;
        let itemsMap = {};
        let devicesMap = {};

        orders.forEach(o => {
            (o.items || []).forEach(i => {
                if (i.type === 'timer' || i.hourly_rate) {
                    const dName = i.device_name || i.name.replace('بازی ', '');
                    timerRev += (i.price || 0);
                    if (!devicesMap[dName]) devicesMap[dName] = { mins: 0, revenue: 0, count: 0 };
                    devicesMap[dName].mins += (i.duration_mins || 0);
                    devicesMap[dName].revenue += (i.price || 0);
                    devicesMap[dName].count++;
                } else {
                    staticRev += (i.price || 0) * (i.qty || 1);
                    if (!itemsMap[i.name]) itemsMap[i.name] = { qty: 0, revenue: 0 };
                    itemsMap[i.name].qty += (i.qty || 1);
                    itemsMap[i.name].revenue += (i.price || 0) * (i.qty || 1);
                }
            });
        });

        csvContent += "خلاصه آمار فروش و درآمد کافه کلاور\n";
        csvContent += `فاکتورهای تسویه‌شده,"${orders.length} عدد"\n`;
        csvContent += `درآمد ثابت‌ها (بوفه),"${staticRev} تومان"\n`;
        csvContent += `درآمد تایمری‌ها (دستگاه‌ها),"${timerRev} تومان"\n`;
        csvContent += `مجموع تسویه نقدی,"${totalCash} تومان"\n`;
        csvContent += `مجموع تسویه کارت‌خوان,"${totalCard} تومان"\n`;
        csvContent += `مجموع تسویه کارت‌به‌کارت / انتقال,"${totalTransfer} تومان"\n`;
        csvContent += `کل درآمد,"${totalRev} تومان"\n\n`;

        csvContent += "پرفروش‌ترین اقلام بوفه,تعداد,درآمد کل (تومان)\n";
        Object.entries(itemsMap).sort((a, b) => b[1].revenue - a[1].revenue).forEach(([name, data]) => {
            csvContent += `"${name}","${data.qty}","${data.revenue}"\n`;
        });

        csvContent += "\nپرکاربردترین دستگاه‌های بازی,تعداد بار,زمان کل (دقیقه),درآمد کل (تومان)\n";
        Object.entries(devicesMap).sort((a, b) => b[1].revenue - a[1].revenue).forEach(([name, data]) => {
            csvContent += `"${name}","${data.count}","${data.mins}","${data.revenue}"\n`;
        });
    } else if (activeSubTab === 'devices') {
        let orders = localOrders.filter(o => o.status !== 'معلق' && o.status !== 'لغو');
        if (fromD) orders = orders.filter(o => new Date(o.created_at) >= new Date(fromD + 'T00:00:00'));
        if (toD) orders = orders.filter(o => new Date(o.created_at) <= new Date(toD + 'T23:59:59.999'));

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

        const sortedDevStats = Object.entries(deviceStats).sort((a, b) => b[1].revenue - a[1].revenue);

        csvContent += "نام دستگاه,تعداد دفعات استفاده (بار),مجموع زمان کارکرد (دقیقه),مجموع زمان کارکرد (ساعت),مجموع درآمد دستگاه (تومان)\n";
        sortedDevStats.forEach(([name, stat]) => {
            csvContent += `"${name}","${stat.count}","${stat.minutes}","${(stat.minutes / 60).toFixed(1)}","${stat.revenue}"\n`;
        });
    } else if (activeSubTab === 'logs') {
        let logs = localLogs;
        if (fromD) logs = logs.filter(l => new Date(l.created_at) >= new Date(fromD + 'T00:00:00'));
        if (toD) logs = logs.filter(l => new Date(l.created_at) <= new Date(toD + 'T23:59:59.999'));
        if (logUserF) logs = logs.filter(l => l.user_name === logUserF);

        csvContent += "تاریخ و زمان,کاربر / پرسنل,نوع رویداد,جزئیات رویداد\n";
        logs.forEach(l => {
            const d = new Date(l.created_at);
            const dateStr = d.toLocaleDateString('fa-IR') + ' ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
            csvContent += `"${dateStr}","${l.user_name || ''}","${l.action || ''}","${(l.details || '').replace(/"/g, '""')}"\n`;
        });
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `cafe_report_${activeSubTab}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('فایل CSV گزارش دانلود شد');
    const subTabName = activeSubTab === 'sales' ? 'فروش' : activeSubTab === 'devices' ? 'دستگاه‌ها' : 'رویدادها/لاگ‌ها';
    logSystemAction('خروجی CSV گزارش', `دریافت فایل CSV از گزارش ${subTabName}`);
};

window.exportReportTXT = function() {
    const el = document.getElementById('printableReport');
    if (!el) { toast('گزارشی برای خروجی متنی وجود ندارد', 'warning'); return; }
    const activeSubTab = document.querySelector('#reportSubTabs .nav-link.active')?.dataset?.tab || 'sales';
    const subTabName = activeSubTab === 'sales' ? 'فروش' : activeSubTab === 'devices' ? 'دستگاه‌ها' : 'رویدادها/لاگ‌ها';
    const text = "\uFEFF" + el.innerText.replace(/\n\s*\n/g, '\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `cafe_report_${Date.now()}.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('فایل متنی (TXT) گزارش دانلود شد');
    logSystemAction('خروجی TXT گزارش', `دریافت فایل TXT از گزارش ${subTabName}`);
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

async function ensureCustomerExists(custName) {
    if (!custName || !custName.trim()) return;
    const cleanName = custName.trim();
    const exist = localCustomers.find(c => (c.full_name || '').toLowerCase() === cleanName.toLowerCase());
    if (!exist) {
        const newCust = { full_name: cleanName, created_at: new Date().toISOString() };
        localCustomers.unshift(newCust);
        if (supa) {
            try {
                await supa.from('customers').insert([newCust]);
            } catch(e){}
        }
    }
}

function renderCustomersList() {
    const sq = document.getElementById('custSearch').value.trim().toLowerCase();
    
    // Aggregate all unique customer names across localCustomers, localOrders, and active deviceSessions
    const allCustNames = new Set();
    localCustomers.forEach(c => { if (c.full_name) allCustNames.add(c.full_name.trim()); });
    localOrders.forEach(o => { if (o.customer_name) allCustNames.add(o.customer_name.trim()); });
    for (const devId in deviceSessions) {
        if (Array.isArray(deviceSessions[devId])) {
            deviceSessions[devId].forEach(p => {
                if (p.customer_name) allCustNames.add(p.customer_name.trim());
            });
        }
    }

    let customerList = Array.from(allCustNames).map(name => {
        const custObj = localCustomers.find(c => c.full_name === name);
        return {
            full_name: name,
            created_at: custObj ? custObj.created_at : null
        };
    });

    if (sq) customerList = customerList.filter(c => c.full_name.toLowerCase().includes(sq));

    let stats = {};
    localOrders.forEach(o => {
        if (o.status !== 'لغو' && o.status !== 'معلق' && o.customer_name) {
            const name = o.customer_name.trim();
            if (!stats[name]) stats[name] = { count: 0, spent: 0 };
            stats[name].count++;
            stats[name].spent += (o.total || 0);
        }
    });

    document.getElementById('customerListTable').innerHTML = customerList.length ? customerList.map(c => {
        const s = stats[c.full_name] || { count: 0, spent: 0 };
        return `
            <div class="border-bottom py-3 d-flex justify-content-between align-items-center">
                <div>
                    <strong class="fs-6 text-dark">${escapeHtml(c.full_name)}</strong>
                    <div class="small mt-1 text-muted"><i class="fas fa-shopping-bag me-1"></i> ${s.count} فاکتور تسویه‌شده | <i class="fas fa-coins me-1"></i> ${formatPrice(s.spent)} تومان خرید</div>
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
        const { error: err2 } = await supa.from('orders').update({ customer_name: newName }).eq('customer_name', oldName).eq('status', 'معلق');
        if (err2) throw err2;

        try {
            await supa.from('active_timer_sessions').update({ customer_name: newName }).eq('customer_name', oldName);
        } catch(e){}

        for (const devId in deviceSessions) {
            if (Array.isArray(deviceSessions[devId])) {
                deviceSessions[devId].forEach(p => {
                    if (p.customer_name === oldName) {
                        p.customer_name = newName;
                    }
                });
            }
        }
        saveDeviceSessionsToStorage();

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
