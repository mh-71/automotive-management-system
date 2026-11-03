/* ============================================================
   Taqwa Automobile Service Center — Worker API
   ------------------------------------------------------------
   Phase B: health plus read-only routes. The frontend still runs
   entirely on localStorage and calls none of this.

   The rule this file exists to establish: the browser never touches
   D1. Every database operation goes through a Worker route, which
   validates its input server-side and binds every SQL parameter.
   ============================================================ */

import { ok, fail, notFound, methodNotAllowed, noDatabase, SECURITY_HEADERS } from './lib/http.js';
import { checkAuth, principalOf } from './lib/auth.js';
// Roles & Permissions (0018): what each route needs, and whether the caller has it.
import { can, collectionPermission, routePermission } from './lib/permissions.js';
import { session } from './routes/session.js';
import {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
} from './routes/customers.js';
import {
  listVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
} from './routes/vehicles.js';
import {
  listServices, getService, createService, updateService, deleteService,
} from './routes/services.js';
import {
  listMechanics, getMechanic, createMechanic, updateMechanic, deleteMechanic,
} from './routes/mechanics.js';
import {
  listParts, getPart, createPart, updatePart, deletePart,
} from './routes/parts.js';
import {
  listAppointments, getAppointment,
  createAppointment, updateAppointment, deleteAppointment,
} from './routes/appointments.js';
// Job cards have child line tables, so they do not go through collectionRoutes();
// the module exports the same handler shapes regardless. Their writes are
// bespoke too: one operation moves the card, both line tables, stock, the
// ledger and an appointment link together.
import {
  listJobCards, getJobCard, createJobCard, updateJobCard, deleteJobCard,
  setJobCardStatus,
} from './routes/job-cards.js';
// Invoices have child line tables too, and their writes are copies rather
// than compositions: an invoice takes its figures and both line sets from a
// job card. Voiding is an action, not a field change -- it releases the
// invoice's payments as advances, which is audit Finding 7.
import {
  listInvoices, getInvoice,
  createInvoice, updateInvoice, deleteInvoice, voidInvoice,
} from './routes/invoices.js';
// Payments are the source of truth for an invoice's balance, so every write
// here recomputes that balance in the same batch. Linking an advance and
// voiding a payment are actions rather than field changes: each carries a
// rule -- overpayment, and what the invoice may then count -- that a PUT
// would let a caller bypass.
import {
  listPayments, getPayment,
  createPayment, updatePayment, deletePayment, voidPayment, linkPayment,
} from './routes/payments.js';
// Write-offs (0002) waive part of an invoice's due without being payments.
// Like payments, every write recomputes the invoice in the same batch, and a
// reversal is an action rather than a field change. There is no update or
// remove: a write-off is never edited or deleted, only voided.
import {
  listInvoiceAdjustments, getInvoiceAdjustment,
  createInvoiceAdjustment, voidInvoiceAdjustment,
} from './routes/invoice-adjustments.js';
import {
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
} from './routes/expenses.js';
// Customer follow-ups (0005). Closing and recording a contact are actions,
// not field changes, and there is no delete: a mistaken follow-up is
// cancelled with a reason. The contact history is append-only -- read or
// voided, never created, edited or removed through its own collection.
import {
  listFollowUps, getFollowUp, createFollowUp, updateFollowUp,
  completeFollowUp, cancelFollowUp, recordContact,
} from './routes/follow-ups.js';
import {
  listFollowUpContacts, getFollowUpContact, voidFollowUpContact,
} from './routes/follow-up-contacts.js';
// Follow-up tasks (0006). Starting, completing and cancelling are actions, not
// field changes, and there is no delete: a mistaken task is cancelled with a
// reason and kept.
import {
  listFollowUpTasks, getFollowUpTask, createFollowUpTask, updateFollowUpTask,
  startFollowUpTask, completeFollowUpTask, cancelFollowUpTask,
} from './routes/follow-up-tasks.js';
import {
  listInventoryTransactions, getInventoryTransaction, createInventoryTransaction,
} from './routes/inventory-transactions.js';
// Estimates & quotations (0007). Sending, recording a decision, cancelling and
// converting to a job card are actions, not field changes, and there is no
// delete: a mistaken estimate is cancelled with a reason and kept. Every route
// is behind the gate; there is no public estimate route.
import {
  listEstimates, getEstimate, createEstimate, updateEstimate,
  sendEstimate, approveEstimate, rejectEstimate, cancelEstimate, convertEstimate,
} from './routes/estimates.js';
// Settings is a singleton the schema enforces (id INTEGER PRIMARY KEY
// CHECK (id = 1)), so it has no list and no addressable detail. It is
// dispatched directly below, beside /api/health, rather than joining
// COLLECTIONS — see routes/settings.js for why.
import { getSettings, updateSettings } from './routes/settings.js';
// The whole staff roster (0008): mechanics plus every other employee, for
// Staff Management › Staff List. No delete -- an employee who leaves is set
// Inactive, so every record that names them keeps its meaning.
import { listStaff, getStaff, createStaff, updateStaff } from './routes/staff.js';
// User accounts (0009): a sign-in for one existing staff member. Every route
// also authorizes -- only an administrator may manage accounts.
import { listAccounts, getAccount, createAccount, updateAccount, setAccountPassword } from './routes/accounts.js';
// Attendance (0010): one record per staff member per day. No delete -- a
// wrong record is corrected through PUT, which refuses a stale edit.
import { listAttendance, getAttendance, createAttendance, updateAttendance } from './routes/attendance.js';
// Leave requests (0011): submitted, then approved or rejected once by an
// administrator. No update and no delete -- a decided request is kept as it is.
import {
  listLeaveRequests, getLeaveRequest, createLeaveRequest, approveLeaveRequest, rejectLeaveRequest,
} from './routes/leave-requests.js';
// Activity log (0012): read-only. Entries are written here, by withActivity()
// around the Staff Management writes below, only after a change succeeded.
import { listActivity, getActivity } from './routes/activity-log.js';
// Workshop Assets › Tools & Equipment (0013) and Equipment Inventory (0021),
// one register. A tool normally leaves service by being retired (tools.manage)
// and can be reactivated; DELETE (tools.delete, 0021) removes a record entered
// by mistake and keeps its history in tool_events.
import { listTools, getTool, createTool, updateTool, retireTool, reactivateTool, deleteTool } from './routes/tools.js';
// Roles & Permissions (0018).
import { listRoles, getRole, createRole, updateRole, deleteRole } from './routes/roles.js';
import { withActivity } from './lib/activity.js';
// Social Inbox › Facebook Messenger (0014). The webhook is public and carries
// Meta's own verification; the inbox routes are behind the gate like any read.
import { messengerWebhook } from './routes/messenger-webhook.js';
import { messenger, MESSENGER_ROUTES } from './routes/messenger.js';
// Social Inbox › WhatsApp (0015): the Cloud API webhook (public, Meta's own
// verification) and the staff inbox routes (behind the gate).
import { whatsappWebhook } from './routes/whatsapp-webhook.js';
import { whatsapp, WHATSAPP_ROUTES } from './routes/whatsapp.js';
// Social Inbox › Website Forms (0016): the website's public submission endpoint
// (validated, rate-limited, CORS for the website only) and the staff routes.
import { publicFormSubmit, listWebsiteForms, getWebsiteForm, updateWebsiteForm } from './routes/website-forms.js';
import { getWebsiteBookings } from './routes/website-bookings.js';
// Notifications Center (0017): the API, and the router-level wrapper that turns
// a successful create/status change into a notification (lib/notifications.js).
import { notifications, NOTIFICATION_ROUTES } from './routes/notifications.js';
import { withNotification } from './lib/notifications.js';
// Offline sync (0020): devices, push / pull, conflicts and invoice drafts.
// Operations are applied through the routes above, as the person who made them.
import { sync, SYNC_ROUTES } from './routes/sync.js';
// What every successful write changed, for devices to pull (0020).
import { withChanges } from './lib/changes.js';

/**
 * Every collection exposes the same two shapes: a list at
 * /api/<name> and a detail at /api/<name>/<id>. Registering them
 * here keeps the path parsing in one place — adding a collection is
 * one line plus its route module, not another branch in the router.
 *
 * `create`/`update`/`remove` are optional. A collection that has them
 * accepts POST on its list path and PUT/DELETE on its detail path; one
 * that does not answers 405 there, with an Allow header naming only what
 * it really takes. The six simple entities have writes as of C-2,
 * appointments as of C-3, job cards as of C-5, invoices as of C-7 and
 * payments as of C-8. Every collection the app writes now has a write
 * path; settings is the one that does not, and C-9 owns it.
 *
 * `actions` is the one exception to "a collection is a list and a detail":
 * a named POST under a record, for a business operation that is not a
 * field change. C-6 added the first, because a job card's status is a
 * transition with its own rules, its own inventory effects and its own
 * appointment sync; C-7 added voiding an invoice, which cancels a
 * document while releasing its payments as advances; C-8 added voiding
 * and linking a payment, each of which moves an invoice's balance. All
 * are refused through PUT deliberately, so no rule has two homes.
 */
const COLLECTIONS = {
  customers: {
    list: listCustomers, detail: getCustomer,
    create: createCustomer, update: updateCustomer, remove: deleteCustomer,
  },
  vehicles: {
    list: listVehicles, detail: getVehicle,
    create: createVehicle, update: updateVehicle, remove: deleteVehicle,
  },
  services: {
    list: listServices, detail: getService,
    create: createService, update: updateService, remove: deleteService,
  },
  mechanics: {
    list: listMechanics, detail: getMechanic,
    create: createMechanic, update: updateMechanic, remove: deleteMechanic,
  },
  parts: {
    list: listParts, detail: getPart,
    create: createPart, update: updatePart, remove: deletePart,
  },
  appointments: {
    list: listAppointments, detail: getAppointment,
    create: createAppointment, update: updateAppointment, remove: deleteAppointment,
  },
  'job-cards': {
    list: listJobCards, detail: getJobCard,
    create: createJobCard, update: updateJobCard, remove: deleteJobCard,
    actions: { status: setJobCardStatus },
  },
  invoices: {
    list: listInvoices, detail: getInvoice,
    create: createInvoice, update: updateInvoice, remove: deleteInvoice,
    actions: { void: voidInvoice },
  },
  payments: {
    list: listPayments, detail: getPayment,
    create: createPayment, update: updatePayment, remove: deletePayment,
    actions: { void: voidPayment, link: linkPayment },
  },
  'invoice-adjustments': {
    list: listInvoiceAdjustments, detail: getInvoiceAdjustment,
    create: createInvoiceAdjustment,
    actions: { void: voidInvoiceAdjustment },
  },
  expenses: {
    list: listExpenses, detail: getExpense,
    create: createExpense, update: updateExpense, remove: deleteExpense,
  },
  // The ledger is append-only: a movement is recorded (POST) and never edited
  // or removed, so there is no update or remove here and none is advertised.
  'inventory-transactions': {
    list: listInventoryTransactions,
    detail: getInventoryTransaction,
    create: createInventoryTransaction,
  },
  'follow-ups': {
    list: listFollowUps, detail: getFollowUp,
    create: createFollowUp, update: updateFollowUp,
    actions: { complete: completeFollowUp, cancel: cancelFollowUp, contact: recordContact },
  },
  'follow-up-contacts': {
    list: listFollowUpContacts, detail: getFollowUpContact,
    actions: { void: voidFollowUpContact },
  },
  'follow-up-tasks': {
    list: listFollowUpTasks, detail: getFollowUpTask,
    create: createFollowUpTask, update: updateFollowUpTask,
    actions: { start: startFollowUpTask, complete: completeFollowUpTask, cancel: cancelFollowUpTask },
  },
  estimates: {
    list: listEstimates, detail: getEstimate,
    create: createEstimate, update: updateEstimate,
    actions: {
      send: sendEstimate, approve: approveEstimate, reject: rejectEstimate,
      cancel: cancelEstimate, convert: convertEstimate,
    },
  },
  staff: {
    list: listStaff, detail: getStaff,
    create: createStaff, update: updateStaff,
  },
  // No remove: an account is deactivated, never deleted.
  accounts: {
    list: listAccounts, detail: getAccount,
    create: createAccount, update: updateAccount,
    actions: { password: setAccountPassword },
  },
  attendance: {
    list: listAttendance, detail: getAttendance,
    create: createAttendance, update: updateAttendance,
  },
  'leave-requests': {
    list: listLeaveRequests, detail: getLeaveRequest,
    create: createLeaveRequest,
    actions: { approve: approveLeaveRequest, reject: rejectLeaveRequest },
  },
  // Read only: no create, update, remove or action can reach the log.
  'activity-log': {
    list: listActivity, detail: getActivity,
  },
  // No create (enquiries arrive through POST /api/forms/submit) and no remove:
  // an unwanted enquiry is Rejected and kept.
  'website-forms': {
    list: listWebsiteForms, detail: getWebsiteForm, update: updateWebsiteForm,
  },
  tools: {
    list: listTools, detail: getTool,
    create: createTool, update: updateTool, remove: deleteTool,
    actions: { retire: retireTool, reactivate: reactivateTool },
  },
  roles: {
    list: listRoles, detail: getRole,
    create: createRole, update: updateRole, remove: deleteRole,
  },
};

/** Methods a collection accepts on /api/<name> and on /api/<name>/:id. */
const listMethods = (c) => (c.create ? ['GET', 'POST'] : ['GET']);
const detailMethods = (c) => [
  'GET',
  ...(c.update ? ['PUT'] : []),
  ...(c.remove ? ['DELETE'] : []),
];

const ROUTES = [
  'GET /api/health',
  ...Object.entries(COLLECTIONS).flatMap(([name, c]) => [
    ...listMethods(c).map((m) => `${m} /api/${name}`),
    ...detailMethods(c).map((m) => `${m} /api/${name}/:id`),
    // An action is always a POST: it performs something, rather than
    // reading or replacing a field.
    ...Object.keys(c.actions ?? {}).map((a) => `POST /api/${name}/:id/${a}`),
  ]),
  // Two entries, not four: a singleton has nothing to address, and there is
  // no create or delete for a row that is permanently id 1. Listed last so
  // the advertised order stays the order the routes shipped in.
  ...MESSENGER_ROUTES,
  // Meta's webhook. Public, necessarily: Meta has no session. It verifies
  // Meta's signature itself (routes/messenger-webhook.js).
  'GET /api/webhooks/messenger',
  'POST /api/webhooks/messenger',
  ...WHATSAPP_ROUTES,
  // The WhatsApp Cloud API webhook: public like Messenger's, verified by
  // Meta's signature itself (routes/whatsapp-webhook.js).
  'GET /api/webhooks/whatsapp',
  'POST /api/webhooks/whatsapp',
  // The website's form endpoint: public, validated and rate-limited itself
  // (routes/website-forms.js).
  'POST /api/forms/submit',
  ...NOTIFICATION_ROUTES,
  ...SYNC_ROUTES,
  // The signed-in person's own password, and the shared passphrase switch
  // (0019): public dispatch, each checks the person's own session itself.
  'POST /api/session/password',
  'PUT /api/session/passphrase',
  'GET /api/settings',
  'PUT /api/settings',
  // Signing in and out. Public, necessarily: a browser with no credential
  // cannot ask for one through a gate that requires one.
  'GET /api/session',
  'POST /api/session',
  'DELETE /api/session',
];

// Captures the collection name and, optionally, everything after the next
// slash. The id group is allowed to be empty so that /api/customers/ reaches
// the id validator (400) rather than falling through to a confusing 404.
const API_PATH = /^\/api\/([a-z-]+)(?:\/(.*))?$/;

/**
 * GET /api/health
 *
 * Reports whether the Worker is up and whether its D1 binding actually
 * answers. Deliberately reads only schema metadata — it touches no
 * business data and writes nothing, so it is safe to call anywhere.
 */
async function health(env) {
  const started = Date.now();

  if (!env.DB) return noDatabase();

  try {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        ORDER BY name`
    ).all();

    const indexes = await env.DB.prepare(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`
    ).first();

    const migrated = tables.results.some((t) => t.name === 'customers');

    const body = {
      service: 'taqwa-api',
      phase: 'B — read-only API',
      timestamp: new Date().toISOString(),
      routes: ROUTES,
      database: {
        bound: true,
        reachable: true,
        tableCount: tables.results.length,
        indexCount: indexes ? indexes.n : 0,
        tables: tables.results.map((t) => t.name),
        migrated,
        latencyMs: Date.now() - started,
        ...(migrated ? {} : { hint: 'Schema not applied. Run: npm run db:migrate:local' }),
      },
    };

    return migrated
      ? ok(body, { ok: true })
      : fail('not_migrated', 'Schema has not been applied to this database.', 503, body);
  } catch (err) {
    console.error('GET /api/health failed:', err);
    return fail('database_error', 'D1 binding is present but did not answer.', 503);
  }
}

// The website-bookings proxy answers with its own bodies, so it takes the same
// headers every other API response carries rather than none. A CSP on a JSON
// response cannot cause the page's CSP violations (those come from _headers);
// it only stops the response being rendered as a document.
const PROXY_HEADERS = { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS };

const WEBSITE_BOOKINGS_URL = 'https://taqwa.blinto.workers.dev/api/bookings/list';

/**
 * GET /api/website-bookings
 *
 * Relays the public website's booking list to the signed-in app, server-side
 * so the browser needs no CORS. The list carries customer names, emails and
 * phone numbers -- the same kind of data as /api/customers -- so it is
 * dispatched through the auth gate like every other business read.
 *
 * Any upstream failure is one generic 500: the upstream's status, body and
 * error text stay in the Worker log and never reach the client.
 */
async function proxyWebsiteBookings() {
  try {
    const res = await fetch(WEBSITE_BOOKINGS_URL);
    if (!res.ok) {
      console.error('Website bookings proxy: upstream answered', res.status);
      return fail('upstream_error', 'Website bookings are unavailable right now.', 500);
    }
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: 200, headers: PROXY_HEADERS });
  } catch (err) {
    console.error('Website bookings proxy error:', err.message);
    return fail('upstream_error', 'Website bookings are unavailable right now.', 500);
  }
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /**
     * Run a route handler, but only once the request has been authenticated.
     *
     * EVERY handler in this file is invoked through here, which is what makes
     * "is this route protected?" a property of the router rather than of each
     * route: no handler can be reached without passing checkAuth(), and a
     * route added later is protected the moment it is dispatched through this
     * function.
     *
     * C-12 made that apply to reads as well. The only routes that do not pass
     * through here are /api/health and /api/session, both dispatched below and
     * both public by necessity rather than by omission.
     *
     * The gate runs BEFORE the handler, so an unauthenticated caller cannot
     * cause a database read or a write, and cannot learn from a 404 whether a
     * record exists.
     */
    const run = async (handler, ...args) => {
      const denied = await checkAuth(request, env);
      if (denied) return denied;
      // Authorization, after authentication and before the handler: the
      // permission this request needs (lib/permissions.js), checked against
      // the caller's role as the gate read it from the database. A route the
      // permission table does not know needs full access -- fail closed.
      const who = principalOf(request);
      // A password someone else set (a new account, an administrator's reset)
      // must be replaced by its owner before anything else (0019).
      if (who && who.passwordChangeRequired) {
        return fail('password_change_required', 'Choose a new password before continuing.', 403);
      }
      if (!can(who, need)) {
        return fail('forbidden', 'Your role does not allow this.', 403);
      }
      return handler(request, env, ...args);
    };
    // Set by each dispatch below, before run() is called.
    let need = routePermission(request.method, url.pathname);

    // The Worker now shares its origin with the static app (see the assets
    // binding in wrangler.jsonc). Asset paths are served before this runs;
    // the bare root is the one path that matches no file, because
    // html_handling is "none" so that every other URL is served exactly as
    // the app asked for it.
    if (url.pathname === '/') {
      return Response.redirect(new URL('/index.html', url).toString(), 302);
    }

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return methodNotAllowed(['GET']);
      // Health is a GET and stays public: it reads schema metadata, writes
      // nothing, and is what tells an operator the Worker is up.
      return health(env);
    }

    // Public, and dispatched before the gate: this is where a browser GETS
    // a credential, so requiring one here would be a closed loop. Each of the
    // three answers is written to give nothing away -- see routes/session.js.
    if (url.pathname === '/api/session') return session(request, env);
    // The signed-in account's own password, and the shared passphrase switch
    // (0019). Each checks the session it needs itself: changing a password must
    // work while "must change password" holds everything else back.
    if (url.pathname === '/api/session/password') return session(request, env, 'password');
    if (url.pathname === '/api/session/passphrase') return session(request, env, 'passphrase');

    // Public, and dispatched before the gate: Meta cannot hold a session.
    // It is protected instead by the verify token (GET) and the App Secret
    // signature on every delivery (POST); an unsigned body is never read.
    if (url.pathname === '/api/webhooks/messenger') return messengerWebhook(request, env, url, ctx);
    if (url.pathname === '/api/webhooks/whatsapp') return whatsappWebhook(request, env, url);

    // Public, and dispatched before the gate: the website's visitors have no
    // session. Protected instead by validation, CORS, a honeypot and a rate limit.
    // The wrapper only reads the answer: a new enquiry (201) becomes a notification.
    if (url.pathname === '/api/forms/submit') {
      return withNotification(request, env, ctx, 'website-forms', 'submit', () => publicFormSubmit(request, env));
    }

    // The Messenger inbox: conversations, messages, replies. Behind the gate.
    if (url.pathname === '/api/messenger' || url.pathname.startsWith('/api/messenger/')) {
      return run(messenger, url, url.pathname.slice('/api/messenger/'.length));
    }

    // The WhatsApp inbox: conversations, messages, replies, assignment. Behind the gate.
    if (url.pathname === '/api/whatsapp' || url.pathname.startsWith('/api/whatsapp/')) {
      return run(whatsapp, url, url.pathname.slice('/api/whatsapp/'.length));
    }

    // The Notifications Center: list, unread count, read / unread. Behind the gate.
    if (url.pathname === '/api/notifications' || url.pathname.startsWith('/api/notifications/')) {
      return run(notifications, url, url.pathname.slice('/api/notifications/'.length));
    }

    // Offline sync (0020): behind the gate; each route also checks the
    // permission it needs (routes/sync.js). Operations are applied by calling
    // this same Worker, so every existing rule still applies to them.
    if (/^\/api\/(sync|devices|invoice-drafts)(\/|$)/.test(url.pathname)) {
      // Internal calls carry the sync request's metered environment (routes/sync.js meter()).
      return run(sync, url, (req, meteredEnv) => worker.fetch(req, meteredEnv || env, ctx), ctx);
    }

    // The exact path only. Anything below it (/api/settings/1, and there is
    // no other id a singleton could have) is left to fall through to the
    // 404 below rather than being handed to a detail handler that does not
    // exist — which is what keeps a trailing segment a clean 404 instead of
    // a TypeError.
    if (url.pathname === '/api/settings') {
      if (request.method === 'GET') return run(getSettings);
      if (request.method === 'PUT') return run(updateSettings);
      return methodNotAllowed(['GET', 'PUT']);
    }

    // Customer contact data, so gated like every business read. Only a
    // signed-in browser asks for it (js/storage.js, after the session check).
    if (url.pathname === '/api/website-bookings') {
      if (request.method === 'GET') return run(proxyWebsiteBookings);
      return methodNotAllowed(['GET']);
    }

    const match = API_PATH.exec(url.pathname);
    if (match) {
      const [, name, rawId] = match;
      const collection = COLLECTIONS[name];

      if (collection) {
        // No trailing segment at all -> the list path.
        if (rawId === undefined) {
          need = collectionPermission(name, 'view');
          if (request.method === 'GET') return run(collection.list, url);
          need = collectionPermission(name, 'create');
          if (request.method === 'POST' && collection.create) {
            return withNotification(request, env, ctx, name, 'create',
              () => withActivity(request, env, name, 'create', () => withChanges(env, name, 'create', null, () => run(collection.create))));
          }
          return methodNotAllowed(listMethods(collection));
        }

        let id;
        try {
          // A malformed escape (%zz) throws rather than returning garbage.
          id = decodeURIComponent(rawId);
        } catch {
          return fail('invalid_id', 'Record id is not valid URL encoding.', 400);
        }

        // A named action under a record, e.g. /api/job-cards/JOB-0007/status.
        // Only an action the collection declares is routed; any other deep
        // path falls through to the id validator exactly as it did before,
        // so an unknown one stays a 400 rather than becoming a 404.
        const slash = id.indexOf('/');
        if (slash !== -1) {
          const actionName = id.slice(slash + 1);
          const action = collection.actions?.[actionName];
          if (action) {
            if (request.method !== 'POST') return methodNotAllowed(['POST']);
            need = collectionPermission(name, actionName);
            return withNotification(request, env, ctx, name, actionName,
              () => withActivity(request, env, name, actionName, () => withChanges(env, name, actionName, id.slice(0, slash), () => run(action, id.slice(0, slash)))));
          }
        }

        need = collectionPermission(name, 'view');
        if (request.method === 'GET') return run(collection.detail, id);
        need = collectionPermission(name, request.method === 'PUT' ? 'update' : 'remove');
        if (request.method === 'PUT' && collection.update) {
          return withNotification(request, env, ctx, name, 'update',
            () => withActivity(request, env, name, 'update', () => withChanges(env, name, 'update', id, () => run(collection.update, id))));
        }
        if (request.method === 'DELETE' && collection.remove) {
          return withChanges(env, name, 'remove', id, () => run(collection.remove, id));
        }
        return methodNotAllowed(detailMethods(collection));
      }
    }

    return notFound(ROUTES);
  },
};

export default worker;
