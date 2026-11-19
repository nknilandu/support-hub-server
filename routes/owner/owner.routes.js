const express = require("express");
const { ObjectId } = require("mongodb");
const Stripe = require("stripe");

const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
};

module.exports = function createOwnerRoutes({
  client,
  users,
  companies,
  tickets,
  notifications,
  invoices,
  verifyFirebaseToken,
  createNotification,
}) {
  const router = express.Router();

  const PAGE_SIZE = 8;
  const ACTIVE_STATUSES = ["assigned", "in_progress"];
  const COMPLETED_STATUSES = ["resolved", "closed"];
  const DAY_MS = 86400000;
  const DHAKA_OFFSET = 6 * 60 * 60 * 1000;

  // =====================================================
  // SUBSCRIPTION PLANS CATALOG (Monthly Only)
  // =====================================================

  const DEFAULT_LIMITS = {
    managers: 1,
    agents: 3,
    tickets: 30,
    ticketsLabel: "30 / mo",
    aiReplies: 50,
    aiResolutionsLabel: "50 AI replies / mo",
  };

  const SUBSCRIPTION_PLANS = [
    {
      id: "starter",
      name: "Starter",
      tagline: "For small support teams",
      price: 19,
      badge: null,
      variant: "blue",
      featured: false,
      limits: {
        managers: 2,
        agents: 6,
        tickets: 500,
        ticketsLabel: "500 / mo",
        aiReplies: 250,
        aiResolutionsLabel: "250 AI replies / mo",
      },
      features: [
        "2 Managers & 6 Support Agents",
        "500 tickets per month",
        "250 AI replies per month",
      ],
    },
    {
      id: "growth",
      name: "Growth",
      tagline: "For growing multi-manager teams",
      price: 49,
      badge: "Most Popular",
      variant: "purple",
      featured: true,
      limits: {
        managers: 5,
        agents: 15,
        tickets: null,
        ticketsLabel: "Unlimited",
        aiReplies: 2500,
        aiResolutionsLabel: "2,500 AI replies / mo",
      },
      features: [
        "5 Managers & 15 Support Agents",
        "Unlimited monthly tickets",
        "2,500 AI replies per month",
      ],
    },
    {
      id: "scale",
      name: "Scale",
      tagline: "For high-volume support operations",
      price: 99,
      badge: null,
      variant: "cyan",
      featured: false,
      limits: {
        managers: 10,
        agents: 40,
        tickets: null,
        ticketsLabel: "Unlimited",
        aiReplies: 10000,
        aiResolutionsLabel: "10,000 AI replies / mo",
      },
      features: [
        "10 Managers & 40 Support Agents",
        "Unlimited monthly tickets",
        "10,000 AI replies per month",
      ],
    },
    {
      id: "enterprise",
      name: "Enterprise",
      tagline: "For large organizations",
      price: 249,
      badge: null,
      variant: "orange",
      featured: false,
      limits: {
        managers: 25,
        agents: 100,
        tickets: null,
        ticketsLabel: "Unlimited",
        aiReplies: null,
        aiResolutionsLabel: "Unlimited AI replies",
      },
      features: [
        "25 Managers & 100 Support Agents",
        "Unlimited monthly tickets",
        "Unlimited AI replies",
      ],
    },
  ];

  const getPlanById = (planId) =>
    SUBSCRIPTION_PLANS.find((p) => p.id === planId) || null;

  const resolveCompanySubscription = (company) => {
    const saved = company?.subscription;

    // Default workspace state before any paid plan
    if (!saved || !saved.planId) {
      return {
        planId: "default",
        planName: "Default Plan",
        tagline: "Standard workspace starter limits",
        billingCycle: "Not Subscribed",
        status: "default",
        price: "$0/mo",
        unitPrice: 0,
        startedAt: company?.createdAt ? new Date(company.createdAt) : null,
        startedDate: company?.createdAt
          ? new Date(company.createdAt).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "Asia/Dhaka",
            })
          : "Not Available",
        expiresAt: null,
        expireDate: "Not Applicable",
        limits: DEFAULT_LIMITS,
      };
    }

    const plan = getPlanById(saved.planId) || SUBSCRIPTION_PLANS[0];
    const startedAt = saved.startedAt ? new Date(saved.startedAt) : new Date();
    const expiresAt = saved.expiresAt
      ? new Date(saved.expiresAt)
      : new Date(startedAt.getTime() + 30 * DAY_MS);

    const isExpired = expiresAt.getTime() <= Date.now();

    return {
      planId: plan.id,
      planName: plan.name,
      tagline: plan.tagline,
      billingCycle: "Monthly",
      status: isExpired ? "expired" : saved.status || "active",
      price: `$${plan.price}/mo`,
      unitPrice: plan.price,
      startedAt,
      startedDate: startedAt.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Dhaka",
      }),
      expiresAt,
      expireDate: expiresAt.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Dhaka",
      }),
      limits: plan.limits,
    };
  };

  // =====================================================
  // HELPERS
  // =====================================================

  const handle = (callback) => async (req, res, next) => {
    try {
      await callback(req, res, next);
    } catch (error) {
      next(error);
    }
  };

  const fail = (status, message) => {
    throw Object.assign(new Error(message), { status });
  };

  const companyScope = (companyId) => ({
    companyId: {
      $in: [companyId, companyId.toHexString()],
    },
  });

  const queryText = (value, name, maxLength = 100) => {
    if (value == null) return "";
    if (typeof value !== "string") {
      fail(400, `${name} must be a string`);
    }
    const result = value.trim();
    if (result.length > maxLength) {
      fail(400, `${name} is too long`);
    }
    return result;
  };

  const getPage = (value, name = "page") => {
    if (value == null || value === "") return 1;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      fail(400, `${name} must be a positive integer`);
    }
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page > 100000) {
      fail(400, `Invalid ${name}`);
    }
    return page;
  };

  const validateUid = (uid, label = "uid") => {
    if (
      typeof uid !== "string" ||
      !uid.trim() ||
      uid.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(uid)
    ) {
      fail(400, `Invalid ${label}`);
    }
    return uid.trim();
  };

  const validateObjectId = (value, label = "id") => {
    if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
      fail(400, `Invalid ${label}`);
    }
    return new ObjectId(value);
  };

  const timeOf = (value) => {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  };

  const dayKey = (value) => {
    if (!value) return null;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return null;
    return new Date(time + DHAKA_OFFSET).toISOString().slice(0, 10);
  };

  const paginate = (items, requestedPage, limit = PAGE_SIZE) => {
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * limit;

    return {
      rows: items.slice(start, start + limit),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  };

  const getPriority = (ticket) => {
    const states = Array.isArray(ticket.aiResult?.states)
      ? ticket.aiResult.states
      : [];

    const priorityState = states.find(
      (state) =>
        typeof state?.title === "string" &&
        state.title.trim().toLowerCase() === "priority",
    );

    const value =
      priorityState?.value ?? ticket.aiResult?.priority ?? ticket.priority;

    return typeof value === "string" ? value.trim().toLowerCase() : null;
  };

  const getResolutionSource = (ticket) => {
    if (["ai", "agent"].includes(ticket.resolutionSource)) {
      return ticket.resolutionSource;
    }
    if (ticket.aiResolved === true) return "ai";
    if (ticket.resolvedBy?.uid) return "agent";
    return "unknown";
  };

  const personProjection = {
    _id: 1,
    uid: 1,
    displayName: 1,
    email: 1,
    photoURL: 1,
    role: 1,
    status: 1,
    verifyIdAgent: 1,
    companyId: 1,
    companyName: 1,
    createdAt: 1,
    updatedAt: 1,
    rejectionReason: 1,
    approvedReason: 1,
  };

  const ticketProjection = {
    _id: 1,
    uid: 1,
    ticketNumber: 1,
    status: 1,
    supportMode: 1,
    aiResolved: 1,
    resolutionSource: 1,
    currentAgent: 1,
    resolvedBy: 1,
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: 1,
    priority: 1,
    "aiResult.ticketTitle": 1,
    "aiResult.summary": 1,
    "aiResult.category": 1,
    "aiResult.priority": 1,
    "aiResult.states": 1,
  };

  const mtCanAssign = (ticket) => {
    if (ticket.supportMode === "ai" || ticket.aiResolved === true) return false;
    const agentUid = ticket.currentAgent?.uid;
    return (
      (ticket.status === "open" && !agentUid) ||
      (["assigned", "in_progress"].includes(ticket.status) && Boolean(agentUid))
    );
  };

  const mtPerson = (person) =>
    person
      ? {
          uid: person.uid,
          displayName: person.displayName || null,
          email: person.email || null,
          photoURL: person.photoURL || null,
          status: person.status || null,
          role: person.role || null,
        }
      : null;

  const mtFormatTicket = (ticket, personMap) => {
    const customer = personMap.get(ticket.uid);
    const assigned = personMap.get(ticket.currentAgent?.uid);

    const userInfo = customer?.role === "customer" ? mtPerson(customer) : null;
    const agentInfo = assigned ? mtPerson(assigned) : null;
    const completed = ["resolved", "closed"].includes(ticket.status);

    return {
      _id: ticket._id,
      ticketNumber: ticket.ticketNumber,
      uid: ticket.uid,
      status: ticket.status,
      supportMode: ticket.supportMode,
      humanSupport: ticket.supportMode !== "ai",
      aiResolved: ticket.aiResolved === true,
      priority: getPriority(ticket),
      resolutionSource: completed ? getResolutionSource(ticket) : null,

      aiResult: {
        ticketTitle: ticket.aiResult?.ticketTitle || null,
        summary: ticket.aiResult?.summary || null,
        category: ticket.aiResult?.category || null,
      },

      userInfo,
      agentUid: ticket.currentAgent?.uid || null,
      agentInfo,

      currentAgent: ticket.currentAgent?.uid
        ? {
            uid: ticket.currentAgent.uid,
            updatedAt: ticket.currentAgent.updatedAt || null,
            displayName: agentInfo?.displayName || null,
            name: agentInfo?.displayName || null,
            email: agentInfo?.email || null,
            status: agentInfo?.status || null,
          }
        : null,

      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      resolvedAt: ticket.resolvedAt || null,

      permission: {
        canManageAssignment: mtCanAssign(ticket),
        canAssign: mtCanAssign(ticket) && !ticket.currentAgent?.uid,
        canReassign: mtCanAssign(ticket) && !!ticket.currentAgent?.uid,
      },
    };
  };

  const mtPeople = async (scope, uids) => {
    const uniqueUids = [
      ...new Set(uids.filter((uid) => typeof uid === "string" && uid)),
    ];
    if (!uniqueUids.length) return new Map();

    const people = await users
      .find(
        {
          ...scope,
          uid: { $in: uniqueUids },
          role: { $in: ["customer", "agent", "manager", "owner"] },
        },
        {
          projection: {
            uid: 1,
            role: 1,
            displayName: 1,
            email: 1,
            photoURL: 1,
            status: 1,
          },
        },
      )
      .toArray();

    return new Map(people.map((person) => [person.uid, person]));
  };

  // =====================================================
  // OWNER AUTHORIZATION MIDDLEWARE
  // =====================================================

  const verifyOwner = handle(async (req, res, next) => {
    if (!req.user?.uid) {
      fail(401, "Authentication required");
    }

    const owner = await users.findOne(
      { uid: req.user.uid },
      { projection: personProjection },
    );

    if (!owner) {
      fail(404, "User account not found");
    }

    if (owner.role !== "owner") {
      fail(403, "Owner access required");
    }

    if (owner.status !== "active") {
      fail(403, "Your account is not active");
    }

    let company = null;

    if (owner.companyId && ObjectId.isValid(owner.companyId)) {
      company = await companies.findOne({
        _id: new ObjectId(owner.companyId),
      });
    }

    if (!company) {
      company = await companies.findOne({
        $or: [
          { ownerUid: owner.uid },
          { primaryManagerUid: owner.uid },
          { owners: owner.uid },
        ],
      });
    }

    if (!company || company.status !== "active") {
      fail(403, "Your workspace company is unavailable or inactive");
    }

    req.owner = owner;
    req.ownerCompany = company;
    req.ownerCompanyId = company._id;
    req.ownerScope = companyScope(company._id);

    res.set("Cache-Control", "no-store");
    next();
  });

  const protectedRoute = [verifyFirebaseToken, verifyOwner];

  // =====================================================
  // 1. GET /dashboard/owner-overview
  // =====================================================

  router.get(
    "/dashboard/owner-overview",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.ownerScope;
      const subscription = resolveCompanySubscription(req.ownerCompany);

      const [workspaceUsers, companyTickets, recentNotifications] =
        await Promise.all([
          users.find(scope, { projection: personProjection }).toArray(),
          tickets.find(scope, { projection: ticketProjection }).toArray(),
          notifications
            .find(
              {
                ...scope,
                uid: req.owner.uid,
              },
              {
                projection: {
                  _id: 1,
                  type: 1,
                  title: 1,
                  message: 1,
                  path: 1,
                  isRead: 1,
                  createdAt: 1,
                },
              },
            )
            .sort({ createdAt: -1, _id: -1 })
            .limit(5)
            .toArray(),
        ]);

      const managers = workspaceUsers.filter((u) => u.role === "manager");
      const agents = workspaceUsers.filter((u) => u.role === "agent");
      const customers = workspaceUsers.filter((u) => u.role === "customer");

      const activeManagersCount = managers.filter(
        (m) =>
          m.status === "active" &&
          !["pending", "rejected"].includes(m.verifyIdAgent),
      ).length;
      const activeAgentsCount = agents.filter(
        (a) => a.status === "active" && a.verifyIdAgent === "approved",
      ).length;

      const seatsUsed = activeManagersCount + activeAgentsCount;
      const seatsLimit =
        (subscription.limits.managers || 0) + (subscription.limits.agents || 0);

      const statusChart = {
        open: 0,
        assigned: 0,
        in_progress: 0,
        resolved: 0,
        closed: 0,
      };

      const resolutionChart = {
        ai: 0,
        agent: 0,
      };

      const categoryCountMap = new Map();

      const now = new Date();
      const today = new Date(`${dayKey(now)}T00:00:00+06:00`);

      const weeklyActivityChart = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today.getTime() - (6 - index) * DAY_MS);
        return {
          dayKey: dayKey(date),
          day: date.toLocaleDateString("en-US", {
            timeZone: "Asia/Dhaka",
            weekday: "short",
          }),
          created: 0,
          resolved: 0,
        };
      });

      const activityMap = new Map(
        weeklyActivityChart.map((item) => [item.dayKey, item]),
      );

      const urgentTickets = [];

      for (const ticket of companyTickets) {
        if (Object.prototype.hasOwnProperty.call(statusChart, ticket.status)) {
          statusChart[ticket.status] += 1;
        }

        const rawCategory = String(ticket.aiResult?.category || "General")
          .trim()
          .toLowerCase();
        const formattedCategory =
          rawCategory.charAt(0).toUpperCase() + rawCategory.slice(1);
        categoryCountMap.set(
          formattedCategory,
          (categoryCountMap.get(formattedCategory) || 0) + 1,
        );

        const createdDay = activityMap.get(dayKey(ticket.createdAt));
        if (createdDay) createdDay.created += 1;

        if (COMPLETED_STATUSES.includes(ticket.status)) {
          const src = getResolutionSource(ticket);
          if (src === "ai") resolutionChart.ai += 1;
          else resolutionChart.agent += 1;

          const resolvedDay = activityMap.get(dayKey(ticket.resolvedAt));
          if (resolvedDay) resolvedDay.resolved += 1;
        }

        const priority = getPriority(ticket);
        if (
          ticket.supportMode !== "ai" &&
          ["open", "assigned", "in_progress"].includes(ticket.status) &&
          ["high", "critical"].includes(priority)
        ) {
          urgentTickets.push({ ...ticket, priority });
        }
      }

      const categoryChart = [...categoryCountMap.entries()]
        .map(([category, count]) => ({ category, tickets: count }))
        .sort((a, b) => b.tickets - a.tickets)
        .slice(0, 5);

      urgentTickets.sort((a, b) => {
        const pDiff =
          (a.priority === "critical" ? 0 : 1) -
          (b.priority === "critical" ? 0 : 1);
        if (pDiff) return pDiff;
        return timeOf(a.createdAt) - timeOf(b.createdAt);
      });

      const personMap = new Map(workspaceUsers.map((u) => [u.uid, u]));

      const formatOverviewTicket = (ticket) => {
        const formatted = mtFormatTicket(ticket, personMap);
        return {
          ...formatted,
          currentAgent: formatted.currentAgent,
        };
      };

      const recentTickets = [...companyTickets]
        .sort(
          (a, b) =>
            timeOf(b.updatedAt || b.createdAt) -
            timeOf(a.updatedAt || a.createdAt),
        )
        .slice(0, 5)
        .map(formatOverviewTicket);

      const allPendingRequests = workspaceUsers
        .filter(
          (u) =>
            (u.role === "agent" || u.role === "manager") &&
            u.verifyIdAgent === "pending",
        )
        .sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))
        .map((u) => ({
          _id: u._id,
          uid: u.uid,
          name: u.displayName || u.email || "User",
          email: u.email,
          requestedRole: u.role,
          status: u.status,
          createdAt: u.createdAt,
        }));

      const pendingRoleRequests = allPendingRequests.slice(0, 5);

      return res.send({
        success: true,
        company: {
          _id: req.ownerCompany._id,
          companyName: req.ownerCompany.companyName,
          companyLogo: req.ownerCompany.companyLogo || null,
        },
        subscription: {
          ...subscription,
          seatsUsed,
          seatsLimit,
          monthlyTicketLimit: subscription.limits.ticketsLabel,
        },
        metrics: {
          totalTickets: companyTickets.length,
          resolvedTickets: statusChart.resolved + statusChart.closed,
          resolvedByAi: resolutionChart.ai,
          resolvedByAgent: resolutionChart.agent,
          urgentTickets: urgentTickets.length,
          totalTeamMembers: seatsUsed,
          managersCount: activeManagersCount,
          agentsCount: activeAgentsCount,
          customersCount: customers.length,
          pendingApprovals: allPendingRequests.length,
        },
        statusChart,
        resolutionChart,
        weeklyActivityChart: weeklyActivityChart.map(
          ({ day, created, resolved }) => ({
            day,
            created,
            resolved,
          }),
        ),
        categoryChart,
        pendingRoleRequests,
        recentTickets,
        urgentTickets: urgentTickets.slice(0, 5).map(formatOverviewTicket),
        notifications: recentNotifications,
      });
    }),
  );

  // =====================================================
  // 2. GET /owner/tickets
  // =====================================================

  const mtCsvFilter = (value, name, allowed) => {
    const text = queryText(value, name, 100);
    if (!text) return [];

    const values = [
      ...new Set(text.split(",").map((item) => item.trim().toLowerCase())),
    ];

    if (values.some((item) => !allowed.includes(item))) {
      fail(400, `Invalid ${name} filter`);
    }

    return values;
  };

  const mtBooleanFilter = (value, name) => {
    if (value == null || value === "") return false;
    if (value === "true") return true;
    if (value === "false") return false;
    fail(400, `${name} must be true or false`);
  };

  // =====================================================
  // 2. GET /owner/tickets
  // =====================================================

  router.get(
    "/owner/tickets",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.ownerScope;
      const page = getPage(req.query.page);
      const search = queryText(req.query.search, "search").toLowerCase();
      const category = queryText(
        req.query.category,
        "category",
        60,
      ).toLowerCase();

      const statuses = mtCsvFilter(req.query.status, "status", [
        "open",
        "assigned",
        "in_progress",
        "resolved",
        "closed",
      ]);

      const priorities = mtCsvFilter(req.query.priority, "priority", [
        "low",
        "medium",
        "high",
        "critical",
      ]);

      const onlyUnassigned = mtBooleanFilter(
        req.query.unassigned,
        "unassigned",
      );
      const onlyUnresolved = mtBooleanFilter(
        req.query.unresolved,
        "unresolved",
      );

      const companyTickets = await tickets
        .find(scope, { projection: ticketProjection })
        .toArray();

      const personMap = await mtPeople(
        scope,
        companyTickets.flatMap((t) => [t.uid, t.currentAgent?.uid]),
      );

      const rows = companyTickets.map((t) => mtFormatTicket(t, personMap));

      const isUnassigned = (t) =>
        t.humanSupport && t.status === "open" && !t.agentUid;

      const counts = {
        total: rows.length,
        unassigned: rows.filter(isUnassigned).length,
        active: rows.filter((t) =>
          ["assigned", "in_progress"].includes(t.status),
        ).length,
        resolved: rows.filter((t) => t.status === "resolved").length,
        closed: rows.filter((t) => t.status === "closed").length,
      };

      const filtered = rows
        .filter((ticket) => {
          if (onlyUnassigned && !isUnassigned(ticket)) return false;

          if (
            onlyUnresolved &&
            !["open", "assigned", "in_progress"].includes(ticket.status)
          ) {
            return false;
          }

          if (statuses.length && !statuses.includes(ticket.status)) {
            return false;
          }

          if (priorities.length && !priorities.includes(ticket.priority)) {
            return false;
          }

          if (
            category &&
            String(ticket.aiResult?.category || "")
              .trim()
              .toLowerCase() !== category
          ) {
            return false;
          }

          if (!search) return true;

          return [
            ticket.ticketNumber,
            ticket.aiResult?.ticketTitle,
            ticket.userInfo?.displayName,
            ticket.userInfo?.email,
          ].some((val) =>
            String(val || "")
              .toLowerCase()
              .includes(search),
          );
        })
        .sort(
          (a, b) =>
            timeOf(b.updatedAt || b.createdAt) -
              timeOf(a.updatedAt || a.createdAt) ||
            String(b._id).localeCompare(String(a._id)),
        );

      const result = paginate(filtered, page);

      return res.send({
        success: true,
        company: {
          _id: req.ownerCompany._id,
          companyName: req.ownerCompany.companyName || null,
          companyLogo: req.ownerCompany.companyLogo || null,
        },
        counts,
        tickets: result.rows,
        pagination: result.pagination,
      });
    }),
  );

  // =====================================================
  // 3. GET /owner/tickets/:id
  // =====================================================

  router.get(
    "/owner/tickets/:id",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");
      const historyPage = getPage(req.query.historyPage, "historyPage");

      const ticket = await tickets.findOne({
        ...req.ownerScope,
        _id: id,
      });

      if (!ticket) fail(404, "Ticket not found");

      const personMap = await mtPeople(req.ownerScope, [
        ticket.uid,
        ticket.currentAgent?.uid,
        ticket.resolvedBy?.uid,
      ]);

      const history = (
        Array.isArray(ticket.actionHistory) ? ticket.actionHistory : []
      )
        .filter((item) =>
          [
            "assigned",
            "reassigned",
            "unassigned",
            "released",
            "resolved",
          ].includes(item.action),
        )
        .map((item) => ({
          action: item.action,
          agentUid: item.agentUid || (item.role === "agent" ? item.uid : null),
          actorUid: item.uid || null,
          actorRole: item.role || null,
          assignedAt: item.date || null,
          note:
            item.action === "reassigned"
              ? "Ticket reassigned"
              : item.action === "unassigned" || item.action === "released"
                ? "Agent unassigned"
                : item.action === "resolved"
                  ? "Ticket resolved"
                  : "Ticket assigned",
        }))
        .sort((a, b) => timeOf(b.assignedAt) - timeOf(a.assignedAt));

      const historyResult = paginate(history, historyPage);

      const historyPeople = await mtPeople(
        req.ownerScope,
        historyResult.rows.map((item) => item.agentUid),
      );

      const formatted = mtFormatTicket(ticket, personMap);
      const resolvedByPerson = personMap.get(ticket.resolvedBy?.uid);
      const isClosedOrResolved = ["resolved", "closed"].includes(ticket.status);
      const isHumanTicket =
        ticket.aiResolved !== true && ticket.supportMode !== "ai";

      const detailedTicket = {
        ...formatted,
        category: ticket.aiResult?.category || ticket.category || null,
        subject: ticket.subject || ticket.ticketData?.subject || null,
        description:
          typeof ticket.ticketData === "string"
            ? ticket.ticketData
            : ticket.ticketData?.description || ticket.description || "",
        ticketData: ticket.ticketData || null,
        aiResult: ticket.aiResult || {},
        currentAgentInfo: formatted.agentInfo,
        resolvedByInfo: resolvedByPerson ? mtPerson(resolvedByPerson) : null,
        permission: {
          ...formatted.permission,
          canRead: true,
          canReadMessages: isHumanTicket,
          canSendMessage: isHumanTicket && !isClosedOrResolved,
          canAssign:
            isHumanTicket && !isClosedOrResolved && mtCanAssign(ticket),
          canRelease:
            isHumanTicket &&
            !isClosedOrResolved &&
            Boolean(ticket.currentAgent?.uid),
          canUnassign:
            isHumanTicket &&
            !isClosedOrResolved &&
            Boolean(ticket.currentAgent?.uid),
          canResolve: isHumanTicket && !isClosedOrResolved,
        },
        assignmentHistory: historyResult.rows.map((item) => {
          const agent = historyPeople.get(item.agentUid);
          return {
            ...item,
            agentInfo: agent?.role === "agent" ? mtPerson(agent) : null,
          };
        }),
      };

      return res.send({
        success: true,
        data: detailedTicket,
        ticket: detailedTicket,
        historyPagination: historyResult.pagination,
      });
    }),
  );

  // =====================================================
  // 3B. GET & POST /owner/tickets/:id/messages
  // =====================================================

  router.get(
    "/owner/tickets/:id/messages",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");

      const ticket = await tickets.findOne(
        { ...req.ownerScope, _id: id },
        { projection: { conversations: 1, messages: 1 } },
      );

      if (!ticket) fail(404, "Ticket not found");

      const rawMessages = Array.isArray(ticket.conversations)
        ? ticket.conversations
        : Array.isArray(ticket.messages)
          ? ticket.messages
          : [];

      const senderUids = rawMessages
        .map((m) => m?.sender?.uid || m?.senderUid || m?.uid)
        .filter(Boolean);

      const personMap = await mtPeople(req.ownerScope, senderUids);

      const conversations = rawMessages.map((item, idx) => {
        const sUid = item?.sender?.uid || item?.senderUid || item?.uid || null;
        const person = sUid ? personMap.get(sUid) : null;

        return {
          _id: item._id || `msg-${idx}-${timeOf(item.createdAt)}`,
          message: item.message || item.text || "",
          createdAt: item.createdAt || null,
          sender: {
            uid: sUid,
            displayName:
              person?.displayName ||
              item?.sender?.displayName ||
              item?.senderName ||
              "User",
            photoURL:
              person?.photoURL ||
              item?.sender?.photoURL ||
              item?.photoURL ||
              null,
            role:
              person?.role || item?.sender?.role || item?.senderRole || "user",
          },
        };
      });

      return res.send({
        success: true,
        conversations,
      });
    }),
  );

  router.post(
    "/owner/tickets/:id/messages",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");
      const rawMessage = req.body?.message;

      if (typeof rawMessage !== "string" || !rawMessage.trim()) {
        fail(400, "Message is required");
      }

      const cleanMessage = rawMessage.trim();
      if (cleanMessage.length > 10000) {
        fail(400, "Message must be at most 10000 characters");
      }

      const ticket = await tickets.findOne({ ...req.ownerScope, _id: id });
      if (!ticket) fail(404, "Ticket not found");

      if (
        COMPLETED_STATUSES.includes(ticket.status) ||
        ticket.aiResolved === true ||
        ticket.supportMode === "ai"
      ) {
        fail(409, "Cannot send messages to this ticket");
      }

      const now = new Date();
      const newMessage = {
        _id: new ObjectId(),
        sender: {
          uid: req.owner.uid,
          displayName: req.owner.displayName || "Workspace Owner",
          photoURL: req.owner.photoURL || null,
          role: "owner",
        },
        message: cleanMessage,
        createdAt: now,
      };

      const targetField = Array.isArray(ticket.messages)
        ? "messages"
        : "conversations";

      await tickets.updateOne(
        { ...req.ownerScope, _id: id },
        {
          $push: { [targetField]: newMessage },
          $set: { updatedAt: now },
        },
      );

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: ticket.uid, path: `/customer/tickets/${ticket._id}` },
          ...(ticket.currentAgent?.uid
            ? [
                {
                  uid: ticket.currentAgent.uid,
                  path: `/agent/tickets/${ticket._id}`,
                },
              ]
            : []),
        ].filter((r) => r.uid && r.uid !== req.owner.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.ownerCompanyId,
              title: "New Reply from Workspace Owner",
              message: `${req.owner.displayName || "Owner"} replied on ${ticket.ticketNumber || "a ticket"}.`,
              type: "ticket_reply",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message: "Reply sent",
        data: newMessage,
      });
    }),
  );

  // =====================================================
  // 4. GET /owner/tickets/:id/eligible-agents
  // =====================================================

  router.get(
    "/owner/tickets/:id/eligible-agents",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");

      const ticket = await tickets.findOne(
        { ...req.ownerScope, _id: id },
        { projection: { status: 1, supportMode: 1, currentAgent: 1 } },
      );

      if (!ticket) fail(404, "Ticket not found");
      if (!mtCanAssign(ticket)) {
        fail(409, "This ticket cannot be assigned or reassigned");
      }

      const agents = await users
        .find(
          {
            ...req.ownerScope,
            role: "agent",
            status: "active",
            verifyIdAgent: "approved",
          },
          {
            projection: {
              uid: 1,
              displayName: 1,
              email: 1,
              photoURL: 1,
            },
          },
        )
        .sort({ displayName: 1 })
        .toArray();

      const rows = await Promise.all(
        agents.map(async (agent) => ({
          ...agent,
          isCurrentAgent: agent.uid === ticket.currentAgent?.uid,
          activeCount: await tickets.countDocuments({
            ...req.ownerScope,
            "currentAgent.uid": agent.uid,
            status: { $in: ACTIVE_STATUSES },
          }),
        })),
      );

      return res.send({
        success: true,
        agents: rows,
      });
    }),
  );

  // =====================================================
  // 5. PATCH /owner/tickets/:id/assign
  // =====================================================

  router.patch(
    "/owner/tickets/:id/assign",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");
      const agentUid = validateUid(req.body?.agentUid, "agentUid");

      const session = client.startSession();
      let saved;

      try {
        await session.withTransaction(async () => {
          const now = new Date();

          const ticket = await tickets.findOne(
            { ...req.ownerScope, _id: id },
            { session },
          );

          if (!ticket) fail(404, "Ticket not found");

          if (
            COMPLETED_STATUSES.includes(ticket.status) ||
            ticket.aiResolved === true ||
            !mtCanAssign(ticket)
          ) {
            fail(409, "This ticket cannot be assigned or reassigned");
          }

          const previousAgentUid = ticket.currentAgent?.uid || null;
          if (previousAgentUid === agentUid) {
            fail(409, "This agent is already assigned to the ticket");
          }

          const agent = await users.findOne(
            {
              ...req.ownerScope,
              uid: agentUid,
              role: "agent",
              status: "active",
              verifyIdAgent: "approved",
            },
            { session, projection: { uid: 1, displayName: 1, email: 1 } },
          );

          if (!agent) {
            fail(409, "Select an active approved agent from your workspace");
          }

          const nextStatus =
            ticket.status === "open" ? "assigned" : ticket.status;

          const result = await tickets.updateOne(
            {
              ...req.ownerScope,
              _id: id,
              status: ticket.status,
              "currentAgent.uid": previousAgentUid,
            },
            {
              $set: {
                supportMode: "human",
                currentAgent: {
                  uid: agentUid,
                  updatedAt: now,
                },
                status: nextStatus,
                updatedAt: now,
              },
              $push: {
                actionHistory: {
                  uid: req.owner.uid,
                  role: "owner",
                  action: previousAgentUid ? "reassigned" : "assigned",
                  agentUid,
                  previousAgentUid,
                  date: now,
                },
              },
            },
            { session },
          );

          if (!result.matchedCount) {
            fail(409, "Ticket changed. Refresh and try again.");
          }

          saved = {
            ticketId: ticket._id,
            ticketNumber: ticket.ticketNumber,
            customerUid: ticket.uid,
            agent,
            previousAgentUid,
            status: nextStatus,
          };
        });
      } finally {
        await session.endSession();
      }

      const message = saved.previousAgentUid
        ? "Ticket reassigned successfully"
        : "Ticket assigned successfully";

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: saved.agent.uid, path: `/agent/tickets/${saved.ticketId}` },
          {
            uid: saved.customerUid,
            path: `/customer/tickets/${saved.ticketId}`,
          },
          ...(saved.previousAgentUid
            ? [{ uid: saved.previousAgentUid, path: "/agent/my-tickets" }]
            : []),
        ].filter((r) => r.uid && r.uid !== req.owner.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.ownerCompanyId,
              title: message,
              message: `${saved.ticketNumber || "Ticket"} was assigned to ${saved.agent.displayName || "an agent"}.`,
              type: "ticket_assigned",
              ticketId: saved.ticketId,
              ticketNumber: saved.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message,
      });
    }),
  );

  // =====================================================
  // 6. PATCH /owner/tickets/:id/unassign
  // =====================================================

  router.patch(
    "/owner/tickets/:id/unassign",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");

      const ticket = await tickets.findOne({ ...req.ownerScope, _id: id });
      if (!ticket) fail(404, "Ticket not found");

      if (
        COMPLETED_STATUSES.includes(ticket.status) ||
        ticket.aiResolved === true ||
        !ticket.currentAgent?.uid
      ) {
        fail(409, "This ticket cannot be unassigned right now");
      }

      const previousAgentUid = ticket.currentAgent.uid;
      const now = new Date();

      const result = await tickets.updateOne(
        {
          ...req.ownerScope,
          _id: id,
          status: ticket.status,
          "currentAgent.uid": previousAgentUid,
        },
        {
          $set: {
            currentAgent: null,
            status: "open",
            updatedAt: now,
          },
          $push: {
            actionHistory: {
              uid: req.owner.uid,
              role: "owner",
              action: "unassigned",
              previousAgentUid,
              date: now,
            },
          },
        },
      );

      if (!result.matchedCount) {
        fail(409, "Ticket changed. Refresh and try again.");
      }

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: previousAgentUid, path: "/agent/my-tickets" },
          { uid: ticket.uid, path: `/customer/tickets/${ticket._id}` },
        ].filter((r) => r.uid && r.uid !== req.owner.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.ownerCompanyId,
              title: "Agent unassigned from ticket",
              message: `${ticket.ticketNumber || "Ticket"} was returned to the open queue.`,
              type: "ticket_released",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message: "Agent unassigned from ticket",
      });
    }),
  );

  // =====================================================
  // 7. PATCH /owner/tickets/:id/resolve
  // =====================================================

  router.patch(
    "/owner/tickets/:id/resolve",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = validateObjectId(req.params.id, "ticket id");

      const ticket = await tickets.findOne({ ...req.ownerScope, _id: id });
      if (!ticket) fail(404, "Ticket not found");

      if (
        COMPLETED_STATUSES.includes(ticket.status) ||
        ticket.aiResolved === true
      ) {
        fail(409, "This ticket cannot be resolved in its current status");
      }

      const now = new Date();

      const result = await tickets.updateOne(
        {
          ...req.ownerScope,
          _id: id,
          status: ticket.status,
          aiResolved: { $ne: true },
        },
        {
          $set: {
            status: "resolved",
            resolutionSource: "agent",
            resolvedAt: now,
            resolvedBy: {
              uid: req.owner.uid,
              role: "owner",
              updatedAt: now,
            },
            updatedAt: now,
          },
          $push: {
            actionHistory: {
              uid: req.owner.uid,
              role: "owner",
              action: "resolved",
              date: now,
            },
          },
        },
      );

      if (!result.matchedCount) {
        fail(409, "Ticket changed. Refresh and try again.");
      }

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: ticket.uid, path: `/customer/tickets/${ticket._id}` },
          ...(ticket.currentAgent?.uid
            ? [
                {
                  uid: ticket.currentAgent.uid,
                  path: `/agent/tickets/${ticket._id}`,
                },
              ]
            : []),
        ].filter((r) => r.uid && r.uid !== req.owner.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.ownerCompanyId,
              title: "Ticket Resolved",
              message: `Ticket ${ticket.ticketNumber || ""} has been marked as resolved by workspace owner.`,
              type: "ticket_resolved",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message: "Ticket resolved successfully",
      });
    }),
  );

  // =====================================================
  // 8. GET /owner/team
  // Query: ?tab=all|manager|agent|customer|pending&search=&status=&page=1
  // =====================================================

  router.get(
    "/owner/team",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.ownerScope;
      const subscription = resolveCompanySubscription(req.ownerCompany);

      const page = getPage(req.query.page);
      const tab = queryText(req.query.tab, "tab", 20) || "all";
      const search = queryText(req.query.search, "search").toLowerCase();
      const status = queryText(req.query.status, "status", 20);

      if (!["all", "manager", "agent", "customer", "pending"].includes(tab)) {
        fail(400, "Invalid team tab");
      }

      const [workspaceUsers, companyTickets] = await Promise.all([
        users
          .find(
            {
              ...scope,
              role: { $in: ["manager", "agent", "customer"] },
            },
            { projection: personProjection },
          )
          .toArray(),
        tickets
          .find(scope, {
            projection: { uid: 1, resolvedBy: 1, status: 1 },
          })
          .toArray(),
      ]);

      const solvedByStaff = new Map();
      const createdByCustomer = new Map();

      for (const t of companyTickets) {
        if (t.uid) {
          createdByCustomer.set(t.uid, (createdByCustomer.get(t.uid) || 0) + 1);
        }
        if (COMPLETED_STATUSES.includes(t.status) && t.resolvedBy?.uid) {
          solvedByStaff.set(
            t.resolvedBy.uid,
            (solvedByStaff.get(t.resolvedBy.uid) || 0) + 1,
          );
        }
      }

      const normalized = workspaceUsers.map((member) => {
        const isStaff = member.role === "agent" || member.role === "manager";
        const isPendingApproval = isStaff && member.verifyIdAgent === "pending";
        const isRejected = isStaff && member.verifyIdAgent === "rejected";

        return {
          ...member,
          displayStatus: isPendingApproval
            ? "pending"
            : isRejected
              ? "rejected"
              : member.status,
          ticketsHandled: solvedByStaff.get(member.uid) || 0,
          ticketsCount: createdByCustomer.get(member.uid) || 0,
        };
      });

      const activeManagers = normalized.filter(
        (m) => m.role === "manager" && m.displayStatus === "active",
      ).length;
      const activeAgents = normalized.filter(
        (m) => m.role === "agent" && m.displayStatus === "active",
      ).length;

      const counts = {
        all: normalized.length,
        managers: normalized.filter(
          (m) => m.role === "manager" && m.displayStatus !== "pending",
        ).length,
        agents: normalized.filter(
          (m) => m.role === "agent" && m.displayStatus !== "pending",
        ).length,
        customers: normalized.filter((m) => m.role === "customer").length,
        pending: normalized.filter((m) => m.displayStatus === "pending").length,
        seatsUsed: activeManagers + activeAgents,
        seatsLimit:
          (subscription.limits.managers || 0) +
          (subscription.limits.agents || 0),
        managerLimit: subscription.limits.managers,
        agentLimit: subscription.limits.agents,
      };

      const filtered = normalized
        .filter((member) => {
          if (tab === "pending") {
            if (member.displayStatus !== "pending") return false;
          } else if (tab !== "all") {
            if (member.role !== tab || member.displayStatus === "pending") {
              return false;
            }
          }

          if (status && member.displayStatus !== status) return false;

          if (!search) return true;

          return (
            String(member.displayName || "")
              .toLowerCase()
              .includes(search) ||
            String(member.email || "")
              .toLowerCase()
              .includes(search)
          );
        })
        .sort(
          (a, b) =>
            timeOf(b.createdAt) - timeOf(a.createdAt) ||
            String(b._id).localeCompare(String(a._id)),
        );

      const { rows, pagination } = paginate(filtered, page);

      return res.send({
        success: true,
        counts,
        members: rows,
        pagination,
      });
    }),
  );

  // =====================================================
  // 9. PATCH /owner/team/:uid/action
  // Body: { action: "role"|"approve"|"reject"|"suspend"|"activate", role?, reason? }
  // =====================================================

  router.patch(
    "/owner/team/:uid/action",
    ...protectedRoute,
    handle(async (req, res) => {
      const uid = validateUid(req.params.uid, "member uid");
      const { action, role, reason } = req.body || {};

      if (
        !["role", "approve", "reject", "suspend", "activate"].includes(action)
      ) {
        fail(400, "Invalid team action");
      }

      const subscription = resolveCompanySubscription(req.ownerCompany);
      const scope = req.ownerScope;

      const member = await users.findOne(
        {
          ...scope,
          uid,
          role: { $in: ["manager", "agent", "customer"] },
        },
        { projection: personProjection },
      );

      if (!member) fail(404, "Team member not found");

      const [activeManagersCount, activeAgentsCount] = await Promise.all([
        users.countDocuments({
          ...scope,
          role: "manager",
          status: "active",
          verifyIdAgent: { $nin: ["pending", "rejected"] },
        }),
        users.countDocuments({
          ...scope,
          role: "agent",
          status: "active",
          verifyIdAgent: "approved",
        }),
      ]);

      const now = new Date();
      const updates = { updatedAt: now };
      let message = "Member updated";

      if (action === "role") {
        if (!["manager", "agent"].includes(role)) {
          fail(400, "Role must be manager or agent");
        }
        if (member.role === "customer") {
          fail(400, "Cannot promote customer directly to staff role");
        }
        if (role === member.role) {
          fail(400, `Member is already a ${role}`);
        }

        if (
          role === "manager" &&
          subscription.limits.managers !== null &&
          activeManagersCount >= subscription.limits.managers
        ) {
          fail(
            409,
            `Manager limit (${subscription.limits.managers}) reached on your ${subscription.planName} plan. Upgrade to add more managers.`,
          );
        }

        if (
          role === "agent" &&
          subscription.limits.agents !== null &&
          activeAgentsCount >= subscription.limits.agents
        ) {
          fail(
            409,
            `Agent limit (${subscription.limits.agents}) reached on your ${subscription.planName} plan.`,
          );
        }

        updates.role = role;
        updates.verifyIdAgent = "approved";
        message = `${member.displayName || "Member"}'s role updated to ${role}`;
      } else if (action === "approve") {
        if (!["manager", "agent"].includes(member.role)) {
          fail(400, "Only manager or agent accounts require approval");
        }

        if (
          member.role === "manager" &&
          subscription.limits.managers !== null &&
          activeManagersCount >= subscription.limits.managers
        ) {
          fail(
            409,
            `Manager seat limit (${subscription.limits.managers}) reached on your current plan.`,
          );
        }

        if (
          member.role === "agent" &&
          subscription.limits.agents !== null &&
          activeAgentsCount >= subscription.limits.agents
        ) {
          fail(
            409,
            `Agent seat limit (${subscription.limits.agents}) reached on your current plan.`,
          );
        }

        updates.verifyIdAgent = "approved";
        updates.status = "active";
        updates.rejectionReason = "";
        updates.approvedAt = now;
        updates.approvedBy = {
          uid: req.owner.uid,
          role: "owner",
          approvedAt: now,
        };
        message = `${member.displayName || "Member"} approved as ${member.role}`;
      } else if (action === "reject") {
        if (!["manager", "agent"].includes(member.role)) {
          fail(400, "Only manager or agent requests can be rejected");
        }

        const cleanReason = typeof reason === "string" ? reason.trim() : "";
        if (!cleanReason) {
          fail(400, "Please provide a rejection reason");
        }
        updates.verifyIdAgent = "rejected";
        updates.rejectionReason = cleanReason.slice(0, 300);
        message = `${member.displayName || "Member"}'s request rejected`;
      } else if (action === "suspend") {
        updates.status = "suspended";
        message = `${member.displayName || "Member"} suspended`;
      } else if (action === "activate") {
        if (
          member.role === "manager" &&
          subscription.limits.managers !== null &&
          activeManagersCount >= subscription.limits.managers
        ) {
          fail(
            409,
            `Manager seat limit (${subscription.limits.managers}) reached.`,
          );
        }
        if (
          member.role === "agent" &&
          subscription.limits.agents !== null &&
          activeAgentsCount >= subscription.limits.agents
        ) {
          fail(
            409,
            `Agent seat limit (${subscription.limits.agents}) reached.`,
          );
        }
        updates.status = "active";
        message = `${member.displayName || "Member"} reactivated`;
      }

      await users.updateOne({ _id: member._id }, { $set: updates });

      if (typeof createNotification === "function") {
        await Promise.allSettled([
          createNotification({
            uid: member.uid,
            companyId: req.ownerCompanyId,
            title: message,
            message:
              action === "reject"
                ? `Your workspace join request was rejected. Reason: ${updates.rejectionReason}`
                : message,
            type: "general",
            path: "/notifications",
          }),
        ]);
      }

      return res.send({
        success: true,
        message,
      });
    }),
  );

  // =====================================================
  // 10. GET /owner/subscription
  // =====================================================

  router.get(
    "/owner/subscription",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.ownerScope;
      const subscription = resolveCompanySubscription(req.ownerCompany);

      const [managersUsed, agentsUsed, aiRepliesUsed, invoiceDocs] =
        await Promise.all([
          users.countDocuments({
            ...scope,
            role: "manager",
            status: "active",
            verifyIdAgent: { $nin: ["pending", "rejected"] },
          }),
          users.countDocuments({
            ...scope,
            role: "agent",
            status: "active",
            verifyIdAgent: "approved",
          }),
          tickets.countDocuments({
            ...scope,
            aiResolved: true,
          }),
          invoices
            ? invoices
                .find({ companyId: req.ownerCompanyId })
                .sort({ createdAt: -1, _id: -1 })
                .limit(15)
                .toArray()
            : Promise.resolve([]),
        ]);

      const formattedInvoices = invoiceDocs.map((inv) => ({
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        transactionId: inv.transactionId || "Not Available",
        planName: inv.planName,
        amount: inv.amount,
        status: inv.status || "paid",
        date: new Date(inv.createdAt).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Dhaka",
        }),
      }));

      return res.send({
        success: true,
        plans: SUBSCRIPTION_PLANS,
        subscription: {
          ...subscription,
          usage: {
            managersUsed,
            agentsUsed,
            aiRepliesUsed,
            aiRepliesLimit: subscription.limits.aiReplies,
          },
        },
        invoices: formattedInvoices,
      });
    }),
  );

  // =====================================================
  // 11A. POST /owner/subscription/checkout-session
  // =====================================================

  router.post(
    "/owner/subscription/checkout-session",
    ...protectedRoute,
    handle(async (req, res) => {
      const stripe = getStripe();
      if (!stripe) {
        fail(500, "STRIPE_SECRET_KEY is missing in server .env");
      }

      const planId = queryText(req.body?.planId, "planId", 30);
      const targetPlan = getPlanById(planId);
      if (!targetPlan) {
        fail(400, "Invalid subscription plan selected");
      }

      const scope = req.ownerScope;

      const [managersUsed, agentsUsed] = await Promise.all([
        users.countDocuments({
          ...scope,
          role: "manager",
          status: "active",
          verifyIdAgent: { $nin: ["pending", "rejected"] },
        }),
        users.countDocuments({
          ...scope,
          role: "agent",
          status: "active",
          verifyIdAgent: "approved",
        }),
      ]);

      if (
        targetPlan.limits.managers !== null &&
        managersUsed > targetPlan.limits.managers
      ) {
        fail(
          409,
          `You have ${managersUsed} active managers, but ${targetPlan.name} allows up to ${targetPlan.limits.managers}.`,
        );
      }

      if (
        targetPlan.limits.agents !== null &&
        agentsUsed > targetPlan.limits.agents
      ) {
        fail(
          409,
          `You have ${agentsUsed} active agents, but ${targetPlan.name} allows up to ${targetPlan.limits.agents}.`,
        );
      }

      const siteDomain = (
        process.env.SITE_DOMAIN ||
        req.headers.origin ||
        "http://localhost:5173"
      ).replace(/\/+$/, "");

      try {
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: Math.round(targetPlan.price * 100),
                product_data: {
                  name: `Subscription: ${targetPlan.name} (Monthly)`,
                  description: `${targetPlan.limits.managers} Managers, ${targetPlan.limits.agents} Agents`,
                },
              },
            },
          ],
          customer_email: req.owner.email,
          mode: "payment",
          metadata: {
            companyId: req.ownerCompanyId.toHexString(),
            ownerUid: req.owner.uid,
            planId: targetPlan.id,
          },
          success_url: `${siteDomain}/owner/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${siteDomain}/owner/payment-cancelled`,
        });

        return res.send({
          success: true,
          url: session.url,
          sessionId: session.id,
        });
      } catch (stripeErr) {
        console.error("Stripe checkout error:", stripeErr);
        fail(502, stripeErr?.message || "Stripe checkout session failed");
      }
    }),
  );

  // =====================================================
  // 11B. PATCH /owner/subscription/verify-payment
  // =====================================================

  router.patch(
    "/owner/subscription/verify-payment",
    ...protectedRoute,
    handle(async (req, res) => {
      const stripe = getStripe();
      if (!stripe) {
        fail(500, "STRIPE_SECRET_KEY is missing in server .env");
      }

      const sessionId = queryText(
        req.query.session_id || req.body?.sessionId,
        "session_id",
        200,
      );
      if (!sessionId) {
        fail(400, "Stripe session_id is required");
      }

      let session;
      try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
      } catch (stripeErr) {
        console.error("Stripe retrieve error:", stripeErr);
        fail(400, stripeErr?.message || "Invalid Stripe session ID");
      }

      if (!session || session.payment_status !== "paid") {
        return res.send({
          success: false,
          message: "Payment is not completed",
        });
      }

      if (session.metadata?.companyId !== req.ownerCompanyId.toHexString()) {
        fail(403, "This payment session does not belong to your workspace");
      }

      if (invoices) {
        const existing = await invoices.findOne({
          stripeSessionId: session.id,
        });
        if (existing) {
          return res.send({
            success: true,
            alreadyProcessed: true,
            invoice: {
              invoiceNumber: existing.invoiceNumber,
              transactionId: existing.transactionId,
              planName: existing.planName,
              amount: existing.amount,
            },
            subscription: resolveCompanySubscription(req.ownerCompany),
          });
        }
      }

      const planId = session.metadata?.planId || "starter";
      const targetPlan = getPlanById(planId) || SUBSCRIPTION_PLANS[0];

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * DAY_MS);

      const updatedSub = {
        planId: targetPlan.id,
        planName: targetPlan.name,
        billingCycle: "Monthly",
        status: "active",
        startedAt: now,
        expiresAt,
        limits: targetPlan.limits,
        stripeSessionId: session.id,
      };

      await companies.updateOne(
        { _id: req.ownerCompanyId },
        {
          $set: {
            subscription: updatedSub,
            updatedAt: now,
          },
        },
      );

      const paidAmount =
        typeof session.amount_total === "number"
          ? `$${(session.amount_total / 100).toFixed(2)}`
          : `$${targetPlan.price}.00`;

      const invoiceNumber = `INV-${now.getFullYear()}-${String(
        Math.floor(1000 + Math.random() * 9000),
      )}`;
      const transactionId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id || session.id;

      if (invoices) {
        await invoices.insertOne({
          companyId: req.ownerCompanyId,
          ownerUid: req.owner.uid,
          stripeSessionId: session.id,
          transactionId,
          invoiceNumber,
          planId: targetPlan.id,
          planName: `${targetPlan.name} (Monthly)`,
          amount: paidAmount,
          status: "paid",
          createdAt: now,
        });
      }

      if (typeof createNotification === "function") {
        await Promise.allSettled([
          createNotification({
            uid: req.owner.uid,
            companyId: req.ownerCompanyId,
            title: "Subscription Activated",
            message: `Payment confirmed for ${targetPlan.name} plan.`,
            type: "general",
            path: "/owner/subscription",
          }),
        ]);
      }

      return res.send({
        success: true,
        message: `${targetPlan.name} plan activated!`,
        invoice: {
          invoiceNumber,
          transactionId,
          planName: `${targetPlan.name} (Monthly)`,
          amount: paidAmount,
        },
        subscription: resolveCompanySubscription({
          ...req.ownerCompany,
          subscription: updatedSub,
        }),
      });
    }),
  );

  return router;
};
