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
async function updateDeviceActivePlayersSegments(deviceId, customTime = null) {
    if (!deviceSessions[deviceId] || !deviceSessions[deviceId].length) return;
    const activePlayers = deviceSessions[deviceId].filter(p => !p.end_time);
    const playerCount = activePlayers.length;
    if (playerCount === 0) return;

    const device = localMenu.find(m => m.id === deviceId && m.is_timer);
    const isVariable = device && device.rate_type === 'variable';
    const totalHourlyRate = getDeviceTotalHourlyRate(device, playerCount);

    const now = customTime ? parseSafeDate(customTime) : getAdjustedNow();
    for (const p of activePlayers) {
        const segStart = parseSafeDate(p.current_segment_start || p.start_time);
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
async function startDevicePlayer(deviceId, customerName, customStartTime = null) {
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

    await updateDeviceActivePlayersSegments(deviceId, customStartTime);

    const nowIso = customStartTime ? parseSafeDate(customStartTime).toISOString() : getAdjustedNow().toISOString();
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
async function stopDevicePlayer(deviceId, customerName, customEndTime = null) {
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

    await updateDeviceActivePlayersSegments(deviceId, customEndTime);

    const now = customEndTime ? parseSafeDate(customEndTime) : getAdjustedNow();
    const nowIso = now.toISOString();
    playerSession.end_time = nowIso;

    // Compute exact total duration in minutes directly from original start_time
    const origStart = parseSafeDate(playerSession.start_time);
    const actualTotalSecs = Math.max(1, Math.floor((now - origStart) / 1000));
    const durationMins = Math.max(1, Math.round(actualTotalSecs / 60));

    // BULLETPROOF FINAL COST CALCULATION (Prevents accumulated_cost DB desync zero/low-cost bugs)
    const finalCost = calculatePlayerCost(playerSession, deviceId, now);

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

// UNIFIED BULLETPROOF COST CALCULATOR (FOR LIVE UI & FINAL SETTLEMENT)
function calculatePlayerCost(playerSession, deviceId, targetTime = getAdjustedNow()) {
    if (!playerSession) return 0;
    const device = localMenu.find(m => m.id === deviceId && m.is_timer);
    if (!device) return 0;

    const now = parseSafeDate(targetTime);
    const origStart = parseSafeDate(playerSession.start_time);
    const totalElapsedSecs = Math.max(0, (now - origStart) / 1000);
    const totalElapsedHours = totalElapsedSecs / 3600;

    const isVariable = device.rate_type === 'variable';

    if (!isVariable) {
        // FIXED RATE MODEL: ALWAYS STRICTLY CALCULATED FROM ORIGINAL START_TIME!
        // Prevents any DB desync or segment reset from wiping out cost!
        const personRate = getDeviceTotalHourlyRate(device, 1);
        return Math.round(totalElapsedHours * personRate);
    } else {
        // VARIABLE RATE MODEL:
        const activeCount = Math.max(1, getActivePlayerCountOnDevice(deviceId));
        const totalHourlyRate = getDeviceTotalHourlyRate(device, activeCount);
        const personRateInSeg = totalHourlyRate / activeCount;

        const segStart = parseSafeDate(playerSession.current_segment_start || playerSession.start_time);
        const segElapsedSecs = Math.max(0, (now - segStart) / 1000);
        const segHours = segElapsedSecs / 3600;
        const currentSegCost = segHours * personRateInSeg;

        const accumCost = Number(playerSession.accumulated_cost || 0);

        // Safety fallback: If accumulated_cost is 0 or less, but segment start moved forward,
        // calculate directly from original start_time to prevent zero/low-cost bugs!
        if (accumCost <= 0 && segStart > origStart) {
            return Math.round(totalElapsedHours * personRateInSeg);
        }

        return Math.round(accumCost + currentSegCost);
    }
}

// Calculate live cost for an active player
function getPlayerLiveCost(playerSession, deviceId) {
    return calculatePlayerCost(playerSession, deviceId, getAdjustedNow());
}

// Attach finished timer session to customer's pending order in localOrders & Supabase
async function attachTimerSessionToCustomerOrder(customerName, sessionData) {
    let pendingOrder = localOrders.find(o => o.customer_name === customerName && o.status === 'معلق');
    
    const sTimeStr = formatTehranTime(sessionData.start_time);
    const eTimeStr = formatTehranTime(sessionData.end_time);

    const timerItem = {
        type: 'timer',
        name: `بازی ${sessionData.device_name}`,
        device_name: sessionData.device_name,
        start_time: sessionData.start_time,
        end_time: sessionData.end_time,
        start_time_str: sTimeStr,
        end_time_str: eTimeStr,
        duration_mins: sessionData.final_duration_mins,
        price: sessionData.final_cost,
        hourly_rate: sessionData.hourly_rate,
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
        if (isDup) return;

        pendingOrder.items.push(timerItem);
        pendingOrder.total = (pendingOrder.total || 0) + sessionData.final_cost;
        if (supa) {
            try {
                await supa.from('orders').update({
                    items: pendingOrder.items,
                    total: pendingOrder.total
                }).eq('id', pendingOrder.id);
            } catch(e){ console.error('Error updating order timer item:', e); }
        }
    } else {
        const createdBy = (typeof userProfile !== 'undefined' && userProfile && userProfile.full_name) 
            ? userProfile.full_name 
            : (typeof currentUser !== 'undefined' && currentUser && currentUser.email ? currentUser.email : 'کارمند');

        const newOrder = {
            customer_name: customerName,
            items: [timerItem],
            total: sessionData.final_cost,
            status: 'معلق',
            created_by: createdBy,
            created_at: getAdjustedNow().toISOString()
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
    saveOrdersToStorage();
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
                const now = getAdjustedNow();
                const start = parseSafeDate(p.start_time);
                const liveSeconds = Math.max(0, Math.floor((now - start) / 1000));
                const liveCost = getPlayerLiveCost(p, device.id);
                const startTimeHMS = formatTehranTime(p.start_time, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
                    <div class="d-flex align-items-center gap-2">
                        ${isActive ? `<button class="btn btn-sm btn-outline-danger py-0 px-2 small" style="font-size:0.75rem;border-radius:8px;" onclick="stopAllDevicePlayersClick(${device.id}, '${escapeHtml(device.name)}')"><i class="fas fa-power-off me-1"></i> پایان همه</button>` : ''}
                        <span class="device-status-badge ${isActive ? 'badge-active' : 'badge-free'}">${isActive ? `${players.length} بازیکن فعال` : 'آزاد'}</span>
                    </div>
                </div>
                <div class="device-rate"><i class="fas fa-clock text-secondary me-1"></i> ${rateLabelHTML}</div>
                <div class="players-list">${playersHTML}</div>
                <div class="device-actions d-flex gap-2">
                    <button class="btn btn-sm btn-primary-custom flex-fill" onclick="addPlayerClick(${device.id})"><i class="fas fa-user-plus me-1"></i> افزودن بازیکن</button>
                    <button class="btn btn-sm btn-outline-primary flex-fill" style="border-radius:12px;" onclick="addGroupPlayersClick(${device.id}, '${escapeHtml(device.name)}')"><i class="fas fa-users me-1"></i> افزودن گروهی</button>
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

// STOP ALL PLAYERS ON DEVICE
async function stopAllDevicePlayersClick(deviceId, deviceName) {
    if (!deviceSessions[deviceId] || !deviceSessions[deviceId].length) return;
    const activePlayers = deviceSessions[deviceId].filter(p => !p.end_time);
    if (!activePlayers.length) return;

    const count = activePlayers.length;
    const confirm = await showConfirmModal(
        'تأیید پایان همه بازی‌ها',
        `آیا از پایان هم‌زمان بازی تمامی ${count} بازیکن روی دستگاه «${deviceName}» اطمینان دارید؟`
    );
    if (!confirm) return;

    uiLoading(true);
    try {
        let endedCount = 0;
        const names = activePlayers.map(p => p.customer_name);
        const sharedEndTime = new Date().toISOString();
        for (const name of names) {
            const ended = await stopDevicePlayer(deviceId, name, sharedEndTime);
            if (ended) endedCount++;
        }
        toast(`بازی تمامی ${endedCount} بازیکن دستگاه «${deviceName}» به پایان رسید.`);
        if (typeof silentRefreshData === 'function') await silentRefreshData();
    } catch (err) {
        console.error('Error stopping all players:', err);
        toast('خطا در پایان دستجمعی بازی‌ها', 'danger');
    } finally {
        uiLoading(false);
    }
}
window.stopAllDevicePlayersClick = stopAllDevicePlayersClick;

// BATCH / GROUP ADD PLAYERS MODAL LOGIC
let currentGroupAddCandidates = [];

function renderGroupAddCandidates() {
    const container = document.getElementById('groupAddCandidatesContainer');
    if (!container) return;
    
    if (!currentGroupAddCandidates.length) {
        container.innerHTML = '<span class="text-muted small italic w-100 text-center py-2" id="groupAddEmptyHint">هنوز هیچ اسمی اضافه نشده است</span>';
        return;
    }

    container.innerHTML = currentGroupAddCandidates.map((name, index) => `
        <span class="badge bg-primary text-white p-2 d-inline-flex align-items-center gap-2 rounded-3 fs-6 shadow-sm">
            <i class="fas fa-user me-1"></i> ${escapeHtml(name)}
            <button type="button" class="btn-close btn-close-white" style="font-size:0.65rem;" onclick="removeGroupAddCandidate(${index})"></button>
        </span>
    `).join('');
}

window.removeGroupAddCandidate = function(index) {
    if (index >= 0 && index < currentGroupAddCandidates.length) {
        currentGroupAddCandidates.splice(index, 1);
        renderGroupAddCandidates();
    }
};

function addGroupPlayersClick(deviceId, deviceName) {
    currentGroupAddCandidates = [];
    renderGroupAddCandidates();

    const titleEl = document.getElementById('groupAddModalTitle');
    if (titleEl) titleEl.innerHTML = `<i class="fas fa-users text-primary me-2"></i>افزودن گروهی - ${escapeHtml(deviceName)}`;
    
    const inputEl = document.getElementById('groupAddInputName');
    if (inputEl) inputEl.value = '';

    const modalEl = document.getElementById('groupAddModal');
    if (!modalEl) return;
    const modal = new bootstrap.Modal(modalEl);

    const appendBtn = document.getElementById('groupAddAppendBtn');
    const submitBtn = document.getElementById('groupAddSubmitBtn');

    const handleAppend = () => {
        const val = inputEl.value.trim();
        if (val) {
            if (currentGroupAddCandidates.includes(val)) {
                toast(`نام «${val}» قبلاً در لیست انتخاب شده قرار دارد`, 'warning');
            } else {
                currentGroupAddCandidates.push(val);
                renderGroupAddCandidates();
                inputEl.value = '';
                inputEl.focus();
            }
        }
    };

    if (appendBtn) appendBtn.onclick = handleAppend;
    if (inputEl) {
        inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleAppend();
            }
        };
    }

    if (submitBtn) {
        submitBtn.onclick = async () => {
            if (!currentGroupAddCandidates.length) {
                toast('لطفاً حداقل نام یک بازیکن را به لیست اضافه کنید', 'warning');
                return;
            }

            const namesToStart = [...currentGroupAddCandidates];
            modal.hide();
            uiLoading(true);

            try {
                let successCount = 0;
                const sharedStartTime = new Date().toISOString();
                for (const name of namesToStart) {
                    const added = await startDevicePlayer(deviceId, name, sharedStartTime);
                    if (added) successCount++;
                }
                toast(`بازی ${successCount} بازیکن به طور هم‌زمان روی دستگاه «${deviceName}» شروع شد.`);
                if (typeof silentRefreshData === 'function') await silentRefreshData();
            } catch(err) {
                console.error('Error in group start:', err);
                toast('خطا در شروع بازی گروهی', 'danger');
            } finally {
                uiLoading(false);
            }
        };
    }

    modal.show();
    setTimeout(() => {
        if (inputEl) inputEl.focus();
    }, 400);
}
window.addGroupPlayersClick = addGroupPlayersClick;
