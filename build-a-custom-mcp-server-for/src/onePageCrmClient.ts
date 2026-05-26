import type { AppConfig } from "./config.js";

type QueryValue = string | number | boolean | undefined | null;

export type OnePageCrmContact = Record<string, unknown>;
export type OnePageCrmAction = Record<string, unknown>;
export type OnePageCrmNote = Record<string, unknown>;

export class OnePageCrmApiError extends Error {
  readonly status: number;
  readonly crmMessage?: string;

  constructor(status: number, message: string, crmMessage?: string) {
    super(message);
    this.name = "OnePageCrmApiError";
    this.status = status;
    this.crmMessage = crmMessage;
  }
}

export class OnePageCrmClient {
  private readonly endpoint: string;
  private readonly authorizationHeader: string;

  constructor(config: AppConfig) {
    this.endpoint = config.onePageCrmEndpoint;
    this.authorizationHeader = `Basic ${Buffer.from(
      `${config.onePageCrmUserId}:${config.onePageCrmApiKey}`
    ).toString("base64")}`;
  }

  async testConnection(): Promise<unknown> {
    return this.request("GET", "/bootstrap");
  }

  async searchContacts(params: {
    query: string;
    email?: string;
    includeTeam?: boolean;
    page?: number;
    perPage?: number;
  }): Promise<unknown> {
    const trimmedQuery = params.query.trim();
    const query: Record<string, QueryValue> = {
      page: params.page,
      per_page: params.perPage,
      team: params.includeTeam || undefined
    };

    if (params.email) {
      query.email = params.email;
      query.search = trimmedQuery || undefined;
    } else if (trimmedQuery.includes("@")) {
      query.email = trimmedQuery;
    } else {
      query.search = trimmedQuery;
    }

    return this.request("GET", "/contacts", { query });
  }

  async getContact(contactId: string): Promise<unknown> {
    return this.request("GET", `/contacts/${encodeURIComponent(contactId)}`);
  }

  async listActions(params: {
    contactId?: string;
    companyId?: string;
    assigneeId?: string;
    status?: string;
    includeDone?: boolean;
    fromDate?: string;
    toDate?: string;
    page?: number;
    perPage?: number;
    fetchAll?: boolean;
  }): Promise<unknown> {
    if (params.fetchAll) {
      return this.listAllActions(params);
    }

    return this.request("GET", "/actions", { query: this.buildActionsQuery(params) });
  }

  private async listAllActions(params: {
    contactId?: string;
    companyId?: string;
    assigneeId?: string;
    status?: string;
    includeDone?: boolean;
    fromDate?: string;
    toDate?: string;
    page?: number;
    perPage?: number;
  }): Promise<unknown> {
    const perPage = params.perPage ?? 100;
    const firstPage = params.page ?? 1;
    let page = firstPage;
    let lastResponse: unknown;
    let lastData: Record<string, unknown> | undefined;
    let totalCount: number | undefined;
    let maxPage: number | undefined;
    const actions: unknown[] = [];

    for (let requestCount = 0; requestCount < 1000; requestCount += 1) {
      const response = await this.request("GET", "/actions", {
        query: this.buildActionsQuery({ ...params, page, perPage })
      });
      const data = isRecord(response) && isRecord(response.data) ? response.data : undefined;
      const pageActions = Array.isArray(data?.actions) ? data.actions : [];

      lastResponse = response;
      lastData = data;
      actions.push(...pageActions);
      totalCount = numberOrUndefined(data?.total_count) ?? totalCount;
      maxPage = numberOrUndefined(data?.max_page) ?? maxPage;

      if (maxPage !== undefined && page >= maxPage) {
        break;
      }
      if (totalCount !== undefined && actions.length >= totalCount) {
        break;
      }
      if (pageActions.length === 0) {
        break;
      }
      if (maxPage === undefined && totalCount === undefined && pageActions.length < perPage) {
        break;
      }
      page += 1;
    }

    const filtered = actions.filter((item: unknown) => {
      if (!isRecord(item)) return true;
      const action = (isRecord((item as Record<string, unknown>).action)
        ? (item as Record<string, unknown>).action
        : item) as Record<string, unknown>;
      const date = stringOrUndefined(action.date);
      if (!date) return true;
      if (params.fromDate && date < params.fromDate) return false;
      if (params.toDate && date > params.toDate) return false;
      return true;
    });

    const mergedResponse = isRecord(lastResponse)
      ? {
          ...lastResponse,
          data: {
            ...(lastData ?? {}),
            actions: filtered,
            total_count: filtered.length,
            page: firstPage,
            per_page: perPage,
            max_page: maxPage ?? page
          }
        }
      : lastResponse;

    return mergedResponse;
  }

  private buildActionsQuery(params: {
    contactId?: string;
    companyId?: string;
    assigneeId?: string;
    status?: string;
    includeDone?: boolean;
    page?: number;
    perPage?: number;
  }): Record<string, QueryValue> {
    return {
      contact_id: params.contactId,
      company_id: params.companyId,
      assignee_id: params.assigneeId,
      status: params.status,
      done: params.status === "done" ? true : params.includeDone ? undefined : false,
      page: params.page,
      per_page: params.perPage
    };
  }

  async createAction(params: {
    contactId: string;
    text: string;
    dueDate?: string;
    status?: string;
    exactTime?: number;
    assigneeId?: string;
    position?: number;
  }): Promise<unknown> {
    const status = params.status ?? (params.exactTime ? "date_time" : params.dueDate ? "date" : "asap");
    const body: Record<string, unknown> = {
      contact_id: params.contactId,
      text: params.text,
      status,
      assignee_id: params.assigneeId,
      date: params.dueDate,
      exact_time: params.exactTime,
      position: params.position
    };

    return this.request("POST", "/actions", { body: compactObject(body) });
  }

  async addNote(params: {
    contactId: string;
    text: string;
    date?: string;
    linkedDealId?: string;
    userIdsToNotify?: string[];
  }): Promise<unknown> {
    const body = compactObject({
      text: params.text,
      date: params.date,
      linked_deal_id: params.linkedDealId,
      user_ids_to_notify: params.userIdsToNotify
    });

    return this.request("POST", `/contacts/${encodeURIComponent(params.contactId)}/notes`, { body });
  }

  async markActionDone(actionId: string): Promise<unknown> {
    const existing = await this.request("GET", `/actions/${encodeURIComponent(actionId)}`);
    const action = unwrapData(existing, "action") as Record<string, unknown> | undefined;

    if (action?.done === true || action?.status === "done") {
      return existing;
    }

    const body = compactObject({
      contact_id: action?.contact_id,
      assignee_id: action?.assignee_id,
      status: action?.status,
      text: action?.text,
      date: action?.date,
      exact_time: action?.exact_time,
      position: action?.position
    });

    return this.request("PUT", `/actions/${encodeURIComponent(actionId)}`, {
      query: { done: true },
      body
    });
  }

  private async request(
    method: string,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: Record<string, unknown> } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.endpoint}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: this.authorizationHeader,
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new OnePageCrmApiError(0, `Could not reach OnePage CRM: ${message}`);
    }

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new OnePageCrmApiError(response.status, friendlyStatusMessage(response.status), payload.message);
    }

    return payload.value;
  }
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
  );
}

function unwrapData(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const data = value.data;
  if (!isRecord(data)) {
    return undefined;
  }
  return data[key];
}

async function readResponsePayload(response: Response): Promise<{ value: unknown; message?: string }> {
  const text = await response.text();
  if (!text) {
    return { value: undefined };
  }

  try {
    const value = JSON.parse(text) as unknown;
    return { value, message: extractMessage(value) };
  } catch {
    return { value: text, message: text.slice(0, 500) };
  }
}

function extractMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidates = [value.message, value.error, value.errors];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function friendlyStatusMessage(status: number): string {
  if (status === 0) {
    return "OnePage CRM could not be reached.";
  }
  if (status === 400) {
    return "OnePage CRM rejected the request. Check that the IDs, dates, and fields are valid.";
  }
  if (status === 401) {
    return "OnePage CRM rejected the credentials. Check ONEPAGECRM_USER_ID and ONEPAGECRM_API_KEY.";
  }
  if (status === 403) {
    return "OnePage CRM says this API user does not have permission for that action.";
  }
  if (status === 404) {
    return "OnePage CRM could not find that record.";
  }
  if (status === 409) {
    return "OnePage CRM reported a conflict. Refresh the record and try again.";
  }
  if (status >= 500) {
    return "OnePage CRM had a temporary server problem. Try again in a few minutes.";
  }
  return `OnePage CRM returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
