/**
 * Google Calendar ServicePlugin
 *
 * Actions: list, get, create, update, delete, search, calendars
 *
 * Uses raw fetch() to Calendar API v3. No googleapis dependency.
 * Auth handled by google-auth.js (OAuth or Service Account).
 */

import { createGoogleAuth } from './google-auth.js';
import { registerPlugin } from './service-plugin.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const auth = createGoogleAuth();

export const calendarPlugin = {
  id: 'calendar',
  name: 'Google Calendar',
  actions: ['list', 'get', 'create', 'update', 'delete', 'search', 'calendars'],

  isConfigured() {
    return auth.isConfigured();
  },

  toolSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'search', 'calendars'] },
      calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
      eventId: { type: 'string', description: 'Event ID (for get, update, delete)' },
      query: { type: 'string', description: 'Search query (for search action)' },
      summary: { type: 'string', description: 'Event title (for create, update)' },
      description: { type: 'string', description: 'Event description' },
      location: { type: 'string', description: 'Event location' },
      startTime: { type: 'string', description: 'Start time ISO 8601 (e.g. 2026-04-05T10:00:00+03:00)' },
      endTime: { type: 'string', description: 'End time ISO 8601 (e.g. 2026-04-05T11:00:00+03:00)' },
      allDay: { type: 'boolean', description: 'If true, use date instead of dateTime' },
      timeMin: { type: 'string', description: 'Show events after this time (ISO 8601)' },
      timeMax: { type: 'string', description: 'Show events before this time (ISO 8601)' },
      maxResults: { type: 'number', description: 'Max results (default 10)' },
      attendees: { type: 'string', description: 'Comma-separated email addresses to invite' },
    },
    required: ['action'],
  },

  async execute(action, params) {
    switch (action) {
      case 'list':      return listEvents(params);
      case 'get':       return getEvent(params);
      case 'create':    return createEvent(params);
      case 'update':    return updateEvent(params);
      case 'delete':    return deleteEvent(params);
      case 'search':    return searchEvents(params);
      case 'calendars': return listCalendars();
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

registerPlugin(calendarPlugin);

// ── Helpers ──────────────────────────────────────────────────────────

async function calFetch(path, options = {}) {
  const token = await auth.getAccessToken();
  const res = await fetch(`${CAL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Calendar API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

function formatEvent(e) {
  return {
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !!e.start?.date,
    status: e.status,
    htmlLink: e.htmlLink,
    attendees: e.attendees?.map(a => ({ email: a.email, status: a.responseStatus })),
    recurringEventId: e.recurringEventId,
    creator: e.creator?.email,
    organizer: e.organizer?.email,
  };
}

// ── Actions ──────────────────────────────────────────────────────────

async function listEvents(params) {
  const calId = encodeURIComponent(params.calendarId || 'primary');
  const qs = new URLSearchParams({
    maxResults: String(params.maxResults || 10),
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  if (params.timeMin) qs.set('timeMin', params.timeMin);
  else qs.set('timeMin', new Date().toISOString()); // default: upcoming
  if (params.timeMax) qs.set('timeMax', params.timeMax);

  const data = await calFetch(`/calendars/${calId}/events?${qs}`);
  return {
    success: true,
    data: {
      events: (data.items || []).map(formatEvent),
      count: data.items?.length || 0,
    },
  };
}

async function getEvent(params) {
  if (!params.eventId) return { success: false, error: 'eventId required' };
  const calId = encodeURIComponent(params.calendarId || 'primary');
  const data = await calFetch(`/calendars/${calId}/events/${params.eventId}`);
  return { success: true, data: formatEvent(data) };
}

async function createEvent(params) {
  if (!params.summary) return { success: false, error: 'summary (title) required' };
  if (!params.startTime) return { success: false, error: 'startTime required' };

  const calId = encodeURIComponent(params.calendarId || 'primary');
  const body = {
    summary: params.summary,
    description: params.description,
    location: params.location,
  };

  if (params.allDay) {
    body.start = { date: params.startTime.split('T')[0] };
    body.end = { date: (params.endTime || params.startTime).split('T')[0] };
  } else {
    body.start = { dateTime: params.startTime };
    body.end = { dateTime: params.endTime || new Date(new Date(params.startTime).getTime() + 3600000).toISOString() };
  }

  if (params.attendees) {
    body.attendees = params.attendees.split(',').map(e => ({ email: e.trim() }));
  }

  const data = await calFetch(`/calendars/${calId}/events`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return { success: true, data: formatEvent(data) };
}

async function updateEvent(params) {
  if (!params.eventId) return { success: false, error: 'eventId required' };
  const calId = encodeURIComponent(params.calendarId || 'primary');

  const body = {};
  if (params.summary) body.summary = params.summary;
  if (params.description) body.description = params.description;
  if (params.location) body.location = params.location;
  if (params.startTime) {
    body.start = params.allDay ? { date: params.startTime.split('T')[0] } : { dateTime: params.startTime };
  }
  if (params.endTime) {
    body.end = params.allDay ? { date: params.endTime.split('T')[0] } : { dateTime: params.endTime };
  }

  const data = await calFetch(`/calendars/${calId}/events/${params.eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

  return { success: true, data: formatEvent(data) };
}

async function deleteEvent(params) {
  if (!params.eventId) return { success: false, error: 'eventId required' };
  const calId = encodeURIComponent(params.calendarId || 'primary');
  await calFetch(`/calendars/${calId}/events/${params.eventId}`, { method: 'DELETE' });
  return { success: true, data: { deleted: params.eventId } };
}

async function searchEvents(params) {
  if (!params.query) return { success: false, error: 'query required' };
  const calId = encodeURIComponent(params.calendarId || 'primary');
  const qs = new URLSearchParams({
    q: params.query,
    maxResults: String(params.maxResults || 10),
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: params.timeMin || new Date().toISOString(),
  });
  if (params.timeMax) qs.set('timeMax', params.timeMax);

  const data = await calFetch(`/calendars/${calId}/events?${qs}`);
  return {
    success: true,
    data: {
      events: (data.items || []).map(formatEvent),
      count: data.items?.length || 0,
      query: params.query,
    },
  };
}

async function listCalendars() {
  const data = await calFetch('/users/me/calendarList');
  return {
    success: true,
    data: {
      calendars: (data.items || []).map(c => ({
        id: c.id,
        summary: c.summary,
        primary: c.primary || false,
        accessRole: c.accessRole,
        timeZone: c.timeZone,
      })),
    },
  };
}
