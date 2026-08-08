// ==========================================
// 1. SUPABASE CONFIGURATION & GLOBALS
// ==========================================
const SUPABASE_URL = 'https://mknpjmdnbgteopvqwzcq.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rbnBqbWRuYmd0ZW9wdnF3emNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MTcwODQsImV4cCI6MjEwMDk5MzA4NH0.-Tysg5UZYoXgKM-BCl1FecaolvwKHr_XfAesKVWeUyc';
let supa = (typeof window !== 'undefined' && window.supabase) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function getSupa() {
    if (!supa && typeof window !== 'undefined' && window.supabase) {
        supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supa;
}

// ==========================================
// STATE & GLOBAL VARS
// ==========================================
let currentUser = null; 
let userProfile = null; 
let cart = []; // Static cafe items in active cart

let localMenu = [];       // Combined static items & timer devices
let localCats = [];       // Categories
let localOrders = [];     // Historical & pending orders
let localProfiles = [];   // Staff profiles
let localCustomers = [];  // Customers list
let localLogs = [];       // System action logs

// Timer Device Active Sessions (Synced in Realtime via Supabase)
let deviceSessions = {}; 

try {
    const saved = localStorage.getItem('cafe_device_sessions');
    if (saved) deviceSessions = JSON.parse(saved);
} catch (e) { deviceSessions = {}; }

function saveDeviceSessionsToStorage() {
    try { localStorage.setItem('cafe_device_sessions', JSON.stringify(deviceSessions)); } catch(e){}
}

// ==========================================
// BULLETPROOF DATE & TIME ZONE UTILITIES (FIXES OLDER PHONES DST & TIME DRIFT)
// ==========================================
let globalTimeOffsetMs = 0;

function parseSafeDate(dStr) {
    if (!dStr) return new Date();
    if (dStr instanceof Date) return dStr;
    let formatted = String(dStr).trim().replace(' ', 'T');
    if (!formatted.includes('Z') && !formatted.includes('+') && !formatted.includes('-')) {
        formatted += 'Z';
    }
    const parsed = new Date(formatted);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getAdjustedNow() {
    return new Date(Date.now() + globalTimeOffsetMs);
}

function formatTehranTime(dateOrStr, options = { hour: '2-digit', minute: '2-digit' }) {
    const d = parseSafeDate(dateOrStr);
    return d.toLocaleTimeString('fa-IR', { ...options, timeZone: 'Asia/Tehran' });
}

function formatTehranDate(dateOrStr) {
    const d = parseSafeDate(dateOrStr);
    return d.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' });
}

function formatTehranDateTime(dateOrStr) {
    const d = parseSafeDate(dateOrStr);
    return `${d.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })} - ${d.toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' })}`;
}

// Convert Supabase active_timer_sessions rows array to deviceSessions dictionary
function parseSupabaseActiveSessions(rows) {
    if (!Array.isArray(rows)) return;
    const dict = {};
    const localNowMs = Date.now();

    rows.forEach(r => {
        const devId = r.device_id;
        if (!dict[devId]) dict[devId] = [];

        const startTimeObj = parseSafeDate(r.start_time);
        const startTimeMs = startTimeObj.getTime();

        // Auto-detect if start_time is in the future relative to local device clock
        // If start_time > localNowMs, update globalTimeOffsetMs so live timer ticks instantly!
        if (startTimeMs > localNowMs + globalTimeOffsetMs) {
            globalTimeOffsetMs = startTimeMs - localNowMs + 1000;
        }

        dict[devId].push({
            id: r.id,
            device_id: r.device_id,
            device_name: r.device_name,
            customer_name: r.customer_name,
            hourly_rate: Number(r.hourly_rate || 0),
            start_time: r.start_time,
            current_segment_start: r.current_segment_start || r.start_time,
            accumulated_cost: Number(r.accumulated_cost || 0),
            accumulated_seconds: Number(r.accumulated_seconds || 0),
            end_time: null
        });
    });
    deviceSessions = dict;
    saveDeviceSessionsToStorage();
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================
function uiLoading(state) { 
    const el = document.getElementById('loadingOverlay');
    if (el) el.style.display = state ? 'flex' : 'none'; 
}

function toast(msg, type = 'success') {
    const c = document.getElementById('toastContainer'); 
    if (!c) return;
    const div = document.createElement('div');
    div.className = `alert alert-${type} shadow-lg py-2 px-3 mb-2 rounded-3 text-center`; 
    div.innerHTML = `<span class="fw-bold">${escapeHtml(msg)}</span>`;
    c.appendChild(div); 
    setTimeout(() => div.remove(), 3000);
}

function formatPrice(p) { 
    return Number(p || 0).toLocaleString('fa-IR'); 
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function logSystemAction(action, details = '') {
    const userName = (userProfile && userProfile.full_name) ? userProfile.full_name : (currentUser ? currentUser.email : 'سیستم');
    const logObj = { user_name: userName, action, details, created_at: new Date().toISOString() };
    localLogs.unshift(logObj);
    
    if (supa) {
        try {
            await supa.from('system_logs').insert([logObj]);
        } catch(e) {
            // Silently ignore if system_logs table has RLS policy or missing column
        }
    }
}
