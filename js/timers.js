// ==========================================
// TIMER & DEVICE LOGIC ENGINE (ACCURATE BILLING)
// ==========================================

// Add a player to a timer device
function startDevicePlayer(deviceId, customerName) {
    if (!deviceId || !customerName) return false;
    const device = localMenu.find(m => m.id === deviceId && m.is_timer);
    if (!device) return false;

    if (!deviceSessions[deviceId]) {
        deviceSessions[deviceId] = [];
    }

    // Check if player is already on this device
    const existing = deviceSessions[deviceId].find(p => p.customer_name === customerName && !p.end_time);
    if (existing) {
        toast('این بازیکن در حال حاضر روی این دستگاه فعال است', 'warning');
        return false;
    }

    const now = new Date().toISOString();
    const rate = Number(device.hourly_rate || device.price || 0);

    deviceSessions[deviceId].push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        device_id: deviceId,
        device_name: device.name,
        customer_name: customerName,
        hourly_rate: rate,
        start_time: now,
        end_time: null
    });

    saveDeviceSessionsToStorage();
    logSystemAction('شروع بازی', `شروع بازی ${customerName} روی دستگاه ${device.name}`);
    return true;
}

// End a player's session on a device
function stopDevicePlayer(deviceId, customerName) {
    if (!deviceSessions[deviceId]) return null;
    const playerIndex = deviceSessions[deviceId].findIndex(p => p.customer_name === customerName && !p.end_time);
    if (playerIndex === -1) return null;

    const playerSession = deviceSessions[deviceId][playerIndex];
    const now = new Date().toISOString();
    playerSession.end_time = now;

    // Calculate final segment and total cost for this session
    const activeCount = getActivePlayerCountOnDevice(deviceId); // count before removal
    const segmentCost = calculateSegmentCost(playerSession.start_time, now, playerSession.hourly_rate, activeCount);
    
    playerSession.final_cost = Math.round(segmentCost);
    const durationMins = Math.max(1, Math.ceil((new Date(now) - new Date(playerSession.start_time)) / 60000));
    playerSession.final_duration_mins = durationMins;

    // Remove from active list
    deviceSessions[deviceId].splice(playerIndex, 1);
    saveDeviceSessionsToStorage();

    // Attach completed timer session to customer's pending order
    attachTimerSessionToCustomerOrder(customerName, playerSession);

    logSystemAction('پایان بازی', `پایان بازی ${customerName} روی دستگاه ${playerSession.device_name} (مدت: ${durationMins} دقیقه، مبلغ: ${formatPrice(playerSession.final_cost)} تومان)`);
    return playerSession;
}

// Get active players count on a device
function getActivePlayerCountOnDevice(deviceId) {
    if (!deviceSessions[deviceId]) return 0;
    return deviceSessions[deviceId].filter(p => !p.end_time).length;
}

// Calculate cost of a time segment (Accurate to exact second)
function calculateSegmentCost(startTimeIso, endTimeIso, hourlyRate, playerCount) {
    if (!startTimeIso || !hourlyRate || !playerCount || playerCount <= 0) return 0;
    const end = endTimeIso ? new Date(endTimeIso) : new Date();
    const start = new Date(startTimeIso);
    const durationSeconds = Math.max(1, Math.floor((end - start) / 1000));
    const durationHours = durationSeconds / 3600;
    const totalDeviceCost = durationHours * hourlyRate;
    return totalDeviceCost / playerCount;
}

// Calculate player's live running cost on an active device
function getPlayerLiveCost(playerSession, deviceId) {
    const playerCount = Math.max(1, getActivePlayerCountOnDevice(deviceId));
    const nowIso = new Date().toISOString();
    return Math.round(calculateSegmentCost(playerSession.start_time, nowIso, playerSession.hourly_rate, playerCount));
}

// Attach finished timer session to customer's pending order in localOrders / Supabase
async function attachTimerSessionToCustomerOrder(customerName, sessionData) {
    let pendingOrder = localOrders.find(o => o.customer_name === customerName && o.status === 'معلق');
    const timerItem = {
        type: 'timer',
        name: `بازی ${sessionData.device_name}`,
        device_name: sessionData.device_name,
        start_time: sessionData.start_time,
        end_time: sessionData.end_time,
        duration_mins: sessionData.final_duration_mins,
        hourly_rate: sessionData.hourly_rate,
        price: sessionData.final_cost,
        qty: 1
    };

    if (pendingOrder) {
        if (!pendingOrder.items) pendingOrder.items = [];
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

// UPDATE LIVE DEVICE CARDS IN UI (WITH SEARCH & CATEGORY FILTERING)
function updateLiveDeviceCardsUI() {
    const container = document.getElementById('liveDevicesContainer');
    if (!container) return;

    const q = (document.getElementById('timerDeviceSearch')?.value || '').trim().toLowerCase();
    const catF = document.getElementById('timerDeviceCatFilter')?.value || '';

    let timerDevices = localMenu.filter(m => m.is_timer);
    if (q) timerDevices = timerDevices.filter(d => d.name.toLowerCase().includes(q));
    if (catF) timerDevices = timerDevices.filter(d => d.cat === catF);

    if (!timerDevices.length) {
        container.innerHTML = '<div class="empty-state">هیچ دستگاه تایمری با این مشخصات یافت نشد</div>';
        return;
    }

    container.innerHTML = timerDevices.map(device => {
        const players = deviceSessions[device.id] || [];
        const isActive = players.length > 0;
        const rate = device.hourly_rate || device.price || 0;

        let playersHTML = '';
        if (isActive) {
            playersHTML = players.map(p => {
                const liveSeconds = Math.max(0, Math.floor((new Date() - new Date(p.start_time)) / 1000));
                const liveCost = getPlayerLiveCost(p, device.id);
                return `
                    <div class="player-item">
                        <div><span class="player-name">${escapeHtml(p.customer_name)}</span></div>
                        <div class="d-flex align-items-center gap-2">
                            <span class="player-timer">${formatDuration(liveSeconds)}</span>
                            <span class="player-cost">${formatPrice(liveCost)} ت</span>
                            <button class="btn btn-sm btn-outline-danger py-0 px-2" onclick="stopPlayerClick(${device.id}, '${escapeHtml(p.customer_name)}')">پایان</button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            playersHTML = '<div class="text-muted small py-2">هیچ بازیکنی روی این دستگاه نیست</div>';
        }

        return `
            <div class="device-card ${isActive ? 'active' : ''}">
                <div class="device-header">
                    <div class="device-title"><i class="fas fa-gamepad text-primary"></i> ${escapeHtml(device.name)}</div>
                    <span class="device-status-badge ${isActive ? 'badge-active' : 'badge-free'}">${isActive ? `${players.length} بازیکن فعال` : 'آزاد'}</span>
                </div>
                <div class="device-rate"><i class="fas fa-clock text-secondary me-1"></i> نرخ هر ساعت: <strong>${formatPrice(rate)} تومان</strong> (تقسیم به ${players.length || 1} نفر)</div>
                <div class="players-list">${playersHTML}</div>
                <div class="device-actions">
                    <button class="btn btn-sm btn-primary-custom flex-fill" onclick="addPlayerClick(${device.id})"><i class="fas fa-user-plus me-1"></i> افزودن بازیکن</button>
                </div>
            </div>
        `;
    }).join('');
}

// Custom Modal Event Handlers for Device Timers
window.addPlayerClick = async function(deviceId) {
    const custName = await showInputModal('افزودن بازیکن به دستگاه', 'نام بازیکن / مشتری را وارد کنید:');
    if (!custName) return;
    if (startDevicePlayer(deviceId, custName)) {
        toast(`بازیکن ${custName} روی دستگاه شروع به بازی کرد`);
        updateLiveDeviceCardsUI();
        if (typeof refreshOrders === 'function') await refreshOrders();
    }
};

window.stopPlayerClick = async function(deviceId, customerName) {
    const confirmStop = await showConfirmModal('پایان بازی', `آیا بازی ${customerName} پایان یابد؟`);
    if (!confirmStop) return;
    const ended = stopDevicePlayer(deviceId, customerName);
    if (ended) {
        toast(`بازی ${customerName} به مدت ${ended.final_duration_mins} دقیقه پایان یافت. هزینه: ${formatPrice(ended.final_cost)} تومان`);
        updateLiveDeviceCardsUI();
        if (typeof refreshOrders === 'function') await refreshOrders();
    }
};
