// ==========================================
// TIMER & DEVICE LOGIC ENGINE
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
    deviceSessions[deviceId].push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        device_id: deviceId,
        device_name: device.name,
        customer_name: customerName,
        hourly_rate: device.hourly_rate || device.price || 0,
        start_time: now,
        end_time: null,
        history_segments: [] // Stores completed segments when player count changes
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
    playerSession.final_duration_mins = Math.max(1, Math.ceil((new Date(now) - new Date(playerSession.start_time)) / 60000));

    // Remove from active list
    deviceSessions[deviceId].splice(playerIndex, 1);
    saveDeviceSessionsToStorage();

    // Attach completed timer session to customer's pending order
    attachTimerSessionToCustomerOrder(customerName, playerSession);

    logSystemAction('پایان بازی', `پایان بازی ${customerName} روی دستگاه ${playerSession.device_name} (مبلغ: ${formatPrice(playerSession.final_cost)} تومان)`);
    return playerSession;
}

// Transfer a player from one device to another
function transferDevicePlayer(fromDeviceId, toDeviceId, customerName) {
    const endedSession = stopDevicePlayer(fromDeviceId, customerName);
    if (endedSession) {
        startDevicePlayer(toDeviceId, customerName);
        const toDevice = localMenu.find(m => m.id === toDeviceId);
        toast(`بازیکن ${customerName} به دستگاه ${toDevice ? toDevice.name : ''} منتقل شد`);
        logSystemAction('انتقال دستگاه', `انتقال ${customerName} از ${endedSession.device_name} به ${toDevice ? toDevice.name : ''}`);
    }
}

// Get active players count on a device
function getActivePlayerCountOnDevice(deviceId) {
    if (!deviceSessions[deviceId]) return 0;
    return deviceSessions[deviceId].filter(p => !p.end_time).length;
}

// Calculate cost of a time segment
function calculateSegmentCost(startTimeIso, endTimeIso, hourlyRate, playerCount) {
    if (!startTimeIso || !hourlyRate || !playerCount || playerCount <= 0) return 0;
    const end = endTimeIso ? new Date(endTimeIso) : new Date();
    const start = new Date(startTimeIso);
    const durationHours = (end - start) / (1000 * 60 * 60);
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
        // Create new pending order for customer
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

// Format duration in minutes into hh:mm:ss
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
        // Only update UI if orders page & devices tab is active
        const devicesTab = document.getElementById('tab-timers');
        if (devicesTab && devicesTab.classList.contains('active')) {
            updateLiveDeviceCardsUI();
        }
    }, 1000);
}
