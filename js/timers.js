// ==========================================
// TIMER & DEVICE LOGIC ENGINE (SUPABASE REALTIME & RACE CONDITION SAFE)
// ==========================================

// Helper: Check if a player name is currently active on ANY device
function findActivePlayerAnywhere(customerName) {
    if (!customerName) return null;
    const cleanName = customerName.trim().toLowerCase();
    for (const [devId, players] of Object.entries(deviceSessions)) {
        if (!players || !players.length) continue;
        const activeP = players.find(p => !p.end_time && (p.customer_name || '').trim().toLowerCase() === cleanName);
        if (activeP) {
            return activeP;
        }
    }
    return null;
}

// Helper: Get exact total hourly rate of a device from menu (Fixed vs Variable Tiered Rate)
function getDeviceTotalHourlyRate(device, playerCount = 1) {
    if (!device) return 0;
    const count = Math.max(1, playerCount);
    
    // Variable Tiered Rate Model
    if (device.rate_type === 'variable' && device.tiered_rates && typeof device.tiered_rates === 'object') {
        if (device.tiered_rates[count] !== undefined && Number(device.tiered_rates[count]) > 0) {
            return Number(device.tiered_rates[count]);
        }
        const keys = Object.keys(device.tiered_rates).map(Number).sort((a, b) => a - b);
        if (keys.length > 0) {
            const highestKey = keys[keys.length - 1];
            const lowestKey = keys[0];
            if (count >= highestKey) return Number(device.tiered_rates[highestKey] || 0);
            if (count <= lowestKey) return Number(device.tiered_rates[lowestKey] || 0);
        }
    }
    
    // Fixed Rate Model (or default fallback)
    const hRate = Number(device.hourly_rate);
    if (!isNaN(hRate) && hRate > 0) return hRate;
    const pRate = Number(device.price);
    if (!isNaN(pRate) && pRate > 0) return pRate;
    return 0;
}

// Helper: Get hourly rate for a single player display
function getDeviceHourlyRate(device) {
    return getDeviceTotalHourlyRate(device, 1);
}

// Helper: Update accumulated costs of all active players on a device before changing player count
async function updateDeviceActivePlayersSegments(deviceId) {
    if (!deviceSessions[deviceId] || !deviceSessions[deviceId].length) return;
    const activePlayers = deviceSessions[deviceId].filter(p => !p.end_time);
    const playerCount = activePlayers.length;
    if (playerCount === 0) return;

    const device = localMenu.find(m => m.id === deviceId && m.is_timer);
    const isVariable = device && device.rate_type === 'variable';
    const totalHourlyRate = getDeviceTotalHourlyRate(device, playerCount);

    const now = new Date();
    for (const p of activePlayers) {
        const segStart = new Date(p.current_segment_start || p.start_time);
        const elapsedSecs = Math.max(0, (now - segStart) / 1000);
        if (elapsedSecs > 0) {
            const segHours = elapsedSecs / 3600;
            let segCostPerPlayer = 0;
            if (isVariable) {
                segCostPerPlayer = (segHours * totalHourlyRate) / playerCount;
            } else {
                // Fixed rate: each player pays the hourly rate per person independently
                const personRate = getDeviceTotalHourlyRate(device, 1);
                segCostPerPlayer = segHours * personRate;
            }
            p.accumulated_cost = (p.accumulated_cost || 0) + segCostPerPlayer;
            p.accumulated_seconds = (p.accumulated_seconds || 0) + elapsedSecs;
        }
        p.current_segment_start = now.toISOString();

        if (supa) {
            try {
                await supa.from('active_timer_sessions').update({
                    current_segment_start: p.current_segment_start,
                    accumulated_cost: p.accumulated_cost,
                    accumulated_seconds: p.accumulated_seconds
                }).eq('id', p.id);
            } catch(e){}
        }
    }
}

// Add a player to a timer device with Supabase Persistence & Unique Name Check
async function startDevicePlayer(deviceId, customerName) {
    if (!deviceId || !customerName || !customerName.trim()) return false;
    const cleanName = customerName.trim();

    // Check with DB directly for double-start race condition
    if (supa) {
        try {
            const { data: dbActive } = await supa.from('active_timer_sessions').select('device_name').ilike('customer_name', cleanName);
            if (dbActive && dbActive.length > 0) {
                toast(`مشتری محترم «${escapeHtml(cleanName)}» هم‌اکنون روی دستگاه «${escapeHtml(dbActive[0].device_name)}» در حال بازی است. ثبت همزمان امکان‌پذیر نیست.`, 'warning');
                if (typeof silentRefreshData === 'function') await silentRefreshData();
                return false;
            }
        } catch(e){}
    }

    const device = localMenu.find(m => m.id === deviceId && m.is_timer);
    if (!device) {
        toast('دستگاه مورد نظر یافت نشد', 'danger');
        return false;
    }

    const rate = getDeviceHourlyRate(device);
    if (rate <= 0) {
        toast('نرخ ساعتی این دستگاه در سیستم ثبت نشده است. لطفاً ابتدا از بخش مدیریت منو، نرخ دستگاه را وارد کنید.', 'danger');
        return false;
    }

    const activeElsewhere = findActivePlayerAnywhere(cleanName);
    if (activeElsewhere) {
        toast(`مشتری محترم «${escapeHtml(cleanName)}» هم‌اکنون روی دستگاه «${escapeHtml(activeElsewhere.device_name)}» در حال بازی است. ثبت همزمان یک نام روی چند دستگاه امکان‌پذیر نمی‌باشد.`, 'warning');
        return false;
    }

    if (!deviceSessions[deviceId]) {
        deviceSessions[deviceId] = [];
    }

    await updateDeviceActivePlayersSegments(deviceId);

    const nowIso = new Date().toISOString();
    const sessionObj = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        device_id: deviceId,
        device_name: device.name,
        customer_name: cleanName,
        hourly_rate: rate,
        start_time: nowIso,
        current_segment_start: nowIso,
        accumulated_cost: 0,
        accumulated_seconds: 0
    };

    deviceSessions[deviceId].push({ ...sessionObj, end_time: null });
    saveDeviceSessionsToStorage();

    if (supa) {
        try {
            const { error: insErr } = await supa.from('active_timer_sessions').insert([sessionObj]);
            if (insErr) {
                console.error('Error inserting active_timer_session:', insErr);
                toast('خطا در ثبت تایمر در دیتابیس (بررسی RLS): ' + insErr.message, 'warning');
            }
        } catch(e) { console.error('Error inserting active_timer_session:', e); }
    }

    if (typeof ensureCustomerExists === 'function') await ensureCustomerExists(cleanName);

    logSystemAction('شروع بازی', `شروع بازی ${cleanName} روی دستگاه ${device.name}`);
    if (typeof broadcastGlobalSync === 'function') broadcastGlobalSync();
    return true;
}

// End a player's session on a device with RACE CONDITION PROTECTION & AUTHORITATIVE DB SYNC
async function stopDevicePlayer(deviceId, customerName) {
    if (!deviceSessions[deviceId]) return null;
    const playerIndex = deviceSessions[deviceId].findIndex(p => p.customer_name === customerName && !p.end_time);
    if (playerIndex === -1) {
        toast(`بازی «${customerName}» قبلاً توسط پرسنل دیگری پایان یافته است.`, 'info');
        if (typeof silentRefreshData === 'function') await silentRefreshData();
        return null;
    }

    const playerSession = deviceSessions[deviceId][playerIndex];

    // AUTHORITATIVE SYNC WITH SUPABASE DB TO PREVENT CROSS-ACCOUNT TIME DRIFT BUGS
    if (supa) {
        try {
            const { data: dbCheck, error: dbErr } = await supa.from('active_timer_sessions').select('*').eq('id', playerSession.id).single();
            if (dbErr || !dbCheck) {
                toast(`بازی «${customerName}» قبلاً روی دستگاه دیگری پایان یافته و به تسویه منتقل شده است.`, 'info');
                deviceSessions[deviceId].splice(playerIndex, 1);
                saveDeviceSessionsToStorage();
                if (typeof silentRefreshData === 'function') await silentRefreshData();
                return null;
            }
            // Overwrite local fields with true DB record values created by the starting account
            if (dbCheck.start_time) playerSession.start_time = dbCheck.start_time;
            if (dbCheck.current_segment_start) playerSession.current_segment_start = dbCheck.current_segment_start;
            if (dbCheck.accumulated_cost !== undefined) playerSession.accumulated_cost = Number(dbCheck.accumulated_cost || 0);
            if (dbCheck.accumulated_seconds !== undefined) playerSession.accumulated_seconds = Number(dbCheck.accumulated_seconds || 0);
        } catch(e) {
            console.error('Database sync error in stopDevicePlayer:', e);
        }
    }

    await updateDeviceActivePlayersSegments(deviceId);

    const now = new Date();
    const nowIso = now.toISOString();
    playerSession.end_time = nowIso;

    // Compute exact total duration in minutes directly from original start_time
    const origStart = new Date(playerSession.start_time);
    const actualTotalSecs = Math.max(1, Math.floor((now - origStart) / 1000));
    const durationMins = Math.max(1, Math.round(actualTotalSecs / 60));

    const finalCost = Math.round(playerSession.accumulated_cost || 0);

    playerSession.final_cost = finalCost;
    playerSession.final_duration_mins = durationMins;

    // ATOMIC DB DELETE PROTECTION (Prevents race condition duplicates across multiple accounts)
    if (supa) {
        try {
            const { data: deletedRows, error: delErr } = await supa.from('active_timer_sessions').delete().eq('id', playerSession.id).select();
            if (delErr || !deletedRows || deletedRows.length === 0) {
                console.log('Session already deleted by another account/device');
                toast(`بازی «${customerName}» هم‌زمان توسط پرسنل دیگری پایان یافت.`, 'info');
                deviceSessions[deviceId].splice(playerIndex, 1);
                saveDeviceSessionsToStorage();
                if (typeof silentRefreshData === 'function') await silentRefreshData();
                return null;
            }
        } catch(e) { 
            console.error('Error deleting active_timer_session:', e); 
        }
    }

    deviceSessions[deviceId].splice(playerIndex, 1);
    saveDeviceSessionsToStorage();

    await attachTimerSessionToCustomerOrder(customerName, playerSession);

    logSystemAction('پایان بازی', `پایان بازی ${customerName} روی دستگاه ${playerSession.device_name} (مدت: ${durationMins} دقیقه، مبلغ: ${formatPrice(finalCost)} تومان)`);
    if (typeof broadcastGlobalSync === 'function') broadcastGlobalSync();
    return playerSession;
}

// Get active players count on a device
function getActivePlayerCountOnDevice(deviceId) {
    if (!deviceSessions[deviceId]) return 0;
    return deviceSessions[deviceId].filter(p => !p.end_time).length;
}

// Calculate live cost for an active player
function getPlayerLiveCost(playerSession, deviceId) {
    if (!playerSession) return 0;
    const activeCount = Math.max(1, getActivePlayerCountOnDevice(deviceId));
    const device = localMenu.find(m => m.id === deviceId && m.is_timer);
    const isVariable = device && device.rate_type === 'variable';
    const totalHourlyRate = getDeviceTotalHourlyRate(device, activeCount);

    const now = new Date();
    const segStart = new Date(playerSession.current_segment_start || playerSession.start_time);
    const elapsedSecs = Math.max(0, (now - segStart) / 1000);
    const currentSegHours = elapsedSecs / 3600;

    let currentSegCost = 0;
    if (isVariable) {
        currentSegCost = (currentSegHours * totalHourlyRate) / activeCount;
    } else {
        const personRate = getDeviceTotalHourlyRate(device, 1);
        currentSegCost = currentSegHours * personRate;
    }
    return Math.round((playerSession.accumulated_cost || 0) + currentSegCost);
}

// Attach finished timer session to customer's pending order in localOrders & Supabase
async function attachTimerSessionToCustomerOrder(customerName, sessionData) {
    let pendingOrder = localOrders.find(o => o.customer_name === customerName && o.status === 'معلق');
    
    const sDate = new Date(sessionData.start_time);
    const eDate = new Date(sessionData.end_time);
    const sTimeStr = sDate.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    const eTimeStr = eDate.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

    const timerItem = {
        type: 'timer',
        name: `بازی ${sessionData.device_name}`,
        device_name: sessionData.device_name,
        start_time: sessionData.start_time,
        end_time: sessionData.end_time,
        start_time_str: sTimeStr,
        end_time_str: eTimeStr,
        duration_mins: sessionData.final_duration_mins,
        hourly_rate: sessionData.hourly_rate,
        price: sessionData.final_cost,
        qty: 1
    };

    if (pendingOrder) {
        if (!pendingOrder.items) pendingOrder.items = [];

        // Deduplication check
        const isDup = pendingOrder.items.some(it => 
            (it.type === 'timer' || it.hourly_rate) &&
            it.device_name === sessionData.device_name &&
            it.start_time === sessionData.start_time
        );
        if (isDup) {
            console.log('Duplicate timer session ignored in attachTimerSessionToCustomerOrder');
            return;
        }

        pendingOrder.items.push(timerItem);
        pendingOrder.total = (pendingOrder.total || 0) + sessionData.final_cost;
        
        if (supa) {
            try {
                await supa.from('orders').update({
                    items: pendingOrder.items,
                    total: pendingOrder.total
                }).eq('id', pendingOrder.id);
            } catch(e) { console.error('Error updating order timer item:', e); }
        }
    } else {
        const createdBy = (userProfile && userProfile.full_name) ? userProfile.full_name : (currentUser ? currentUser.email : 'کارمند');
        const newOrder = {
            customer_name: customerName,
            items: [timerItem],
            total: sessionData.final_cost,
            status: 'معلق',
            created_by: createdBy,
            created_at: new Date().toISOString()
        };

        if (supa) {
            try {
                const { data, error } = await supa.from('orders').insert([newOrder]).select();
                if (data && data[0]) {
                    localOrders.unshift(data[0]);
                } else {
                    localOrders.unshift(newOrder);
                }
            } catch(e) { 
                localOrders.unshift(newOrder);
            }
        } else {
            localOrders.unshift(newOrder);
        }
    }
}

// Format duration in seconds into hh:mm:ss
function formatDuration(secondsTotal) {
    const hrs = Math.floor(secondsTotal / 3600);
    const mins = Math.floor((secondsTotal % 3600) / 60);
    const secs = Math.floor(secondsTotal % 60);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Global 1-second interval update for UI live timers
let liveTimerInterval = null;

function startLiveTimerTicker() {
    if (liveTimerInterval) clearInterval(liveTimerInterval);
    liveTimerInterval = setInterval(() => {
        const devicesTab = document.getElementById('tab-timers');
        if (devicesTab && devicesTab.classList.contains('active')) {
            updateLiveDeviceCardsUI();
        }
    }, 1000);
}

// UPDATE LIVE DEVICE CARDS IN UI
function updateLiveDeviceCardsUI() {
    const container = document.getElementById('liveDevicesContainer');
    if (!container) return;

    const q = (document.getElementById('timerDeviceSearch')?.value || '').trim().toLowerCase();
    const catF = document.getElementById('timerDeviceCatFilter')?.value || '';

    let timerDevices = localMenu.filter(m => m.is_timer);
    if (q) timerDevices = timerDevices.filter(d => d.name.toLowerCase().includes(q));
    if (catF) timerDevices = timerDevices.filter(d => d.cat === catF);

    if (typeof sortMenuItemsByCategory === 'function') {
        timerDevices = sortMenuItemsByCategory(timerDevices);
    }

    if (!timerDevices.length) {
        container.innerHTML = '<div class="empty-state">هیچ دستگاه تایمری با این مشخصات یافت نشد</div>';
        return;
    }

    container.innerHTML = timerDevices.map(device => {
        const players = deviceSessions[device.id] || [];
        const isActive = players.length > 0;
        const rate = getDeviceHourlyRate(device);

        let playersHTML = '';
        if (isActive) {
            playersHTML = players.map(p => {
                const now = new Date();
                const start = new Date(p.start_time);
                const liveSeconds = Math.max(0, Math.floor((now - start) / 1000));
                const liveCost = getPlayerLiveCost(p, device.id);
                const startTimeHMS = start.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                return `
                    <div class="player-item">
                        <div>
                            <span class="player-name">${escapeHtml(p.customer_name)}</span>
                            <div class="small text-muted" style="font-size:0.75rem;"><i class="far fa-clock me-1"></i> شروع: ${startTimeHMS}</div>
                        </div>
                        <div class="d-flex align-items-center gap-2">
                            <span class="player-timer">${formatDuration(liveSeconds)}</span>
                            <span class="player-cost">${formatPrice(liveCost)} ت</span>
                            <button class="btn btn-sm btn-outline-danger py-0 px-2" data-device-id="${device.id}" data-customer-name="${escapeHtml(p.customer_name)}" onclick="stopPlayerBtnClick(this)">پایان</button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            playersHTML = '<div class="text-muted small py-2">هیچ بازیکنی روی این دستگاه نیست</div>';
        }

        const isVar = device.rate_type === 'variable';
        const totalDevRate = isVar ? getDeviceTotalHourlyRate(device, players.length || 1) : getDeviceTotalHourlyRate(device, 1);
        const rateLabelHTML = isVar 
            ? `نرخ متغیر (${players.length || 1} نفره): <strong>${formatPrice(totalDevRate)} تومان</strong> (تقسیم بین ${players.length || 1} نفر)`
            : `نرخ ثابت: <strong>${formatPrice(totalDevRate)} تومان/ساعت</strong> (به ازای هر نفر)`;

        return `
            <div class="device-card ${isActive ? 'active' : ''}">
                <div class="device-header">
                    <div class="device-title"><i class="fas fa-gamepad text-primary"></i> ${escapeHtml(device.name)}</div>
                    <span class="device-status-badge ${isActive ? 'badge-active' : 'badge-free'}">${isActive ? `${players.length} بازیکن فعال` : 'آزاد'}</span>
                </div>
                <div class="device-rate"><i class="fas fa-clock text-secondary me-1"></i> ${rateLabelHTML}</div>
                <div class="players-list">${playersHTML}</div>
                <div class="device-actions">
                    <button class="btn btn-sm btn-primary-custom flex-fill" onclick="addPlayerClick(${device.id})"><i class="fas fa-user-plus me-1"></i> افزودن بازیکن</button>
                </div>
            </div>
        `;
    }).join('');
}

// Custom Modal Event Handlers for Device Timers
async function addPlayerClick(deviceId) {
    const custName = await showInputModal('افزودن بازیکن به دستگاه', 'نام بازیکن / مشتری را وارد کنید:');
    if (!custName) return;
    uiLoading(true);
    try {
        const added = await startDevicePlayer(deviceId, custName);
        if (added) {
            toast(`بازیکن ${custName} روی دستگاه شروع به بازی کرد`);
            if (typeof silentRefreshData === 'function') await silentRefreshData();
        }
    } catch(err) {
        console.error('Error starting player:', err);
        toast('خطا در ثبت شروع بازی', 'danger');
    } finally {
        uiLoading(false);
    }
}
window.addPlayerClick = addPlayerClick;

function stopPlayerBtnClick(btnEl) {
    if (!btnEl) return;
    const deviceId = Number(btnEl.dataset.deviceId);
    const customerName = btnEl.dataset.customerName;
    stopPlayerClick(deviceId, customerName);
}
window.stopPlayerBtnClick = stopPlayerBtnClick;

async function stopPlayerClick(deviceId, customerName) {
    const confirmStop = await showConfirmModal('پایان بازی', `آیا بازی ${customerName} پایان یابد؟`);
    if (!confirmStop) return;
    
    uiLoading(true);
    try {
        const ended = await stopDevicePlayer(deviceId, customerName);
        if (ended) {
            toast(`بازی ${customerName} به مدت ${ended.final_duration_mins} دقیقه پایان یافت. هزینه: ${formatPrice(ended.final_cost)} تومان`);
            if (typeof silentRefreshData === 'function') await silentRefreshData();
        }
    } catch(err) {
        console.error('Error stopping player:', err);
        toast('خطا در پایان بازی', 'danger');
    } finally {
        uiLoading(false);
    }
}
window.stopPlayerClick = stopPlayerClick;
