import { isAbortError } from "../../lib/abortError";
import { isEventDateAlreadyPast, toCalendarYmd } from "../../lib/dateUtils";
import { supabase } from "../../lib/supabase";
import { cacheService } from "../cacheService";
import { eventoEhCopiaDoConvidado } from "./conviteParticipacaoEventoService";
import {
  getUserPermissions,
  hasPermission,
  normalizeArtistMemberRole,
} from "./permissionsService";

const SUPABASE_URL = "https://ctulmpyaikxsnjqmrzxf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0dWxtcHlhaWt4c25qcW1yenhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MzkxMjMsImV4cCI6MjA3MzIxNTEyM30.bu0gER4uTIZ5PDV7t1-fcwU01UZAJ6aFG6axFZQlU8U";

/**
 * Envia push (Edge Function send-push) para todos os membros do artista, exceto `excludeUserId`.
 */
export const notifyArtistMembersPush = async (
  artistId: string,
  excludeUserId: string,
  title: string,
  message: string,
  data: Record<string, any> = {},
): Promise<void> => {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        artist_id: artistId,
        creator_user_id: excludeUserId,
        title,
        message,
        data,
      }),
    });

    const json = await response.json();

    if (!response.ok) {
      console.error("⚠️ Erro ao enviar notificações push:", json);
    } else {
      console.log("✅ Notificações push enviadas:", json);
    }
  } catch (error) {
    console.error("⚠️ Erro ao chamar função de notificação:", error);
    // Não falha a operação se o push falhar
  }
};

export interface Event {
  id: string;
  artist_id: string;
  created_by: string;
  updated_by?: string | null;
  name: string;
  description?: string;
  /** Descrição opt-in mostrada para colaboradores viewer (distinta de `description`, interna). */
  viewer_description?: string | null;
  event_date: string;
  start_time: string;
  end_time: string;
  value?: number;
  /** Valor já pago/antecipado. Sem valor (null/0) o app não mostra progresso. */
  paid_amount?: number | null;
  city?: string;
  state_uf?: string | null;
  contractor_phone?: string;
  confirmed: boolean;
  /** Data visível no calendário público do perfil (sem cachê). */
  is_public?: boolean;
  /** Show especial em destaque no perfil (cartaz). */
  is_featured?: boolean;
  highlight_image_url?: string | null;
  featured_at?: string | null;
  tag: "ensaio" | "evento" | "reunião";
  ativo?: boolean;
  update_ativo?: string | null;
  /** URL pública do arquivo de contrato (Storage) */
  contract_url?: string | null;
  /** Nome original do arquivo anexado */
  contract_file_name?: string | null;
  /** Evento criado ao aceitar convite de participação */
  convite_participacao_id?: string | null;
  /** Anúncio do feed (`disponivel` / `demanda`). NULL = evento normal da agenda. */
  feed_tipo?: "disponivel" | "demanda" | null;
  created_at: string;
  updated_at: string;
}

const EVENT_AGENDA_SELECT =
  "id, artist_id, created_by, name, description, viewer_description, event_date, start_time, end_time, value, paid_amount, city, state_uf, contractor_phone, confirmed, tag, created_at, updated_at, convite_participacao_id, is_public, ativo, feed_tipo";

function excludeFeedMarketplaceEvents<
  T extends { id?: string; feed_tipo?: string | null; ativo?: boolean | null },
>(events: T[] | null | undefined): T[] {
  const seen = new Set<string>();
  return (events ?? []).filter((event) => {
    if (event.ativo === false) {
      return false;
    }
    const tipo = event.feed_tipo;
    if (tipo != null && String(tipo).trim() !== "") return false;
    const id = event.id != null ? String(event.id) : "";
    if (id) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function calendarMonthBounds(year: number, monthIndex: number): { startDate: string; endDate: string } {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return {
    startDate: `${year}-${pad2(monthIndex + 1)}-01`,
    endDate: `${year}-${pad2(monthIndex + 1)}-${pad2(lastDay)}`,
  };
}

function inDateRange(eventDate: unknown, startDate: string, endDate: string): boolean {
  const day = toCalendarYmd(eventDate);
  return !!day && day >= startDate && day <= endDate;
}

function coerceEventRow(row: Event): Event {
  const raw = Number(row.value);
  return {
    ...row,
    event_date: toCalendarYmd(row.event_date),
    value: Number.isFinite(raw) ? raw : undefined,
    ativo: row.ativo !== false,
  };
}

async function fetchArtistAgendaEvents(
  artistId: string,
  abortSignal?: AbortSignal,
): Promise<{ events: Event[]; error: string | null; aborted?: boolean }> {
  const runTable = async (withFeedTipo: boolean) => {
    let query = supabase
      .from("events")
      .select("*")
      .eq("artist_id", artistId)
      .eq("ativo", true)
      .order("event_date", { ascending: true });
    if (withFeedTipo) query = query.is("feed_tipo", null);
    if (abortSignal) query = query.abortSignal(abortSignal);
    return query;
  };

  let tableRes = await runTable(true);
  if (abortSignal?.aborted || isAbortError(tableRes.error)) {
    return { events: [], error: null, aborted: true };
  }
  if (tableRes.error && /feed_tipo/i.test(tableRes.error.message || "")) {
    tableRes = await runTable(false);
    if (abortSignal?.aborted || isAbortError(tableRes.error)) {
      return { events: [], error: null, aborted: true };
    }
  }

  const fromTable = tableRes.error
    ? []
    : excludeFeedMarketplaceEvents(
        ((tableRes.data || []) as Event[]).map(coerceEventRow),
      );
  const tableHasValue = fromTable.some((event) => Number(event.value) > 0);

  if (fromTable.length > 0 && tableHasValue) {
    return { events: fromTable, error: null };
  }

  let rpc = supabase.rpc("get_events_by_role", { p_artist_id: artistId });
  if (abortSignal) rpc = rpc.abortSignal(abortSignal);
  const rpcRes = await rpc;
  if (abortSignal?.aborted || isAbortError(rpcRes.error)) {
    return { events: [], error: null, aborted: true };
  }
  if (!rpcRes.error && rpcRes.data) {
    const fromRpc = excludeFeedMarketplaceEvents(
      ((rpcRes.data || []) as Event[]).map(coerceEventRow),
    );
    if (fromTable.length === 0) {
      return { events: fromRpc, error: null };
    }
    const valueById = new Map(
      fromRpc.map((event) => [String(event.id), Number(event.value) || 0]),
    );
    return {
      events: fromTable.map((event) => {
        const tableVal = Number(event.value);
        const rpcVal = valueById.get(String(event.id));
        const value =
          Number.isFinite(tableVal) && tableVal > 0
            ? tableVal
            : Number.isFinite(rpcVal) && (rpcVal as number) > 0
              ? rpcVal
              : event.value;
        return { ...event, value };
      }),
      error: null,
    };
  }

  if (fromTable.length > 0) {
    return { events: fromTable, error: null };
  }
  return { events: [], error: tableRes.error?.message || rpcRes.error?.message || null };
}

function maskEventValueForRole<T extends { created_by?: string; value?: unknown; paid_amount?: unknown }>(
  row: T,
  role: string | null | undefined,
  userId: string | null | undefined,
): T {
  const canSee =
    role === "admin" ||
    role === "owner" ||
    (role === "vendedor" && !!userId && row.created_by === userId);
  if (canSee) return row;
  return { ...row, value: null, paid_amount: null };
}

export interface EventExpense {
  id: string;
  event_id: string;
  name: string;
  value: number;
  receipt_url?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateEventData {
  artist_id: string;
  user_id: string;
  name: string;
  description?: string;
  viewer_description?: string | null;
  event_date: string;
  start_time: string;
  end_time: string;
  value?: number;
  paid_amount?: number | null;
  city?: string;
  state_uf?: string | null;
  contractor_phone?: string;
  confirmed?: boolean;
  is_public?: boolean;
  is_featured?: boolean;
  highlight_image_url?: string | null;
  tag?: "ensaio" | "evento" | "reunião";
  expenses?: CreateExpenseData[];
  contract_url?: string | null;
  contract_file_name?: string | null;
  convite_participacao_id?: string | null;
}

export interface CreateExpenseData {
  name: string;
  value: number;
  receipt_url?: string;
}

export interface UpdateEventData {
  name?: string;
  description?: string;
  viewer_description?: string | null;
  value?: number;
  paid_amount?: number | null;
  city?: string;
  state_uf?: string | null;
  contractor_phone?: string;
  event_date?: string;
  start_time?: string;
  end_time?: string;
  confirmed?: boolean;
  is_public?: boolean;
  is_featured?: boolean;
  highlight_image_url?: string | null;
  tag?: "ensaio" | "evento" | "reunião";
  contract_url?: string | null;
  contract_file_name?: string | null;
  updated_by?: string | null;
}

// Criar evento com despesas
export const createEvent = async (
  eventData: CreateEventData,
): Promise<{ success: boolean; error: string | null; event?: Event }> => {
  try {
    console.log("📝 Criando evento:", {
      artist_id: eventData.artist_id,
      user_id: eventData.user_id,
      name: eventData.name,
    });

    const insertPayload: Record<string, unknown> = {
      artist_id: eventData.artist_id,
      created_by: eventData.user_id, // Quem criou o evento
      updated_by: eventData.user_id,
      name: eventData.name,
      description: eventData.description || null,
      viewer_description: eventData.viewer_description || null,
      event_date: eventData.event_date,
      start_time: eventData.start_time,
      end_time: eventData.end_time,
      // Preservar R$ 0,00 (0 é um valor válido; `|| null` convertia 0 em null)
      value: eventData.value ?? null,
      paid_amount: eventData.paid_amount ?? null,
      city: eventData.city || null,
      state_uf:
        eventData.state_uf != null && String(eventData.state_uf).trim()
          ? String(eventData.state_uf).trim().toUpperCase().slice(0, 2)
          : null,
      contractor_phone: eventData.contractor_phone || null,
      confirmed: eventData.confirmed || false,
      is_public:
        Boolean(eventData.confirmed) &&
        Boolean(eventData.is_public || eventData.is_featured),
      is_featured: Boolean(eventData.confirmed) && Boolean(eventData.is_featured),
      highlight_image_url: eventData.highlight_image_url ?? null,
      featured_at:
        Boolean(eventData.confirmed) && Boolean(eventData.is_featured)
          ? new Date().toISOString()
          : null,
      tag: eventData.tag || "evento", // Default para 'evento' se não especificado
      contract_url: eventData.contract_url ?? null,
      contract_file_name: eventData.contract_file_name ?? null,
      convite_participacao_id: eventData.convite_participacao_id ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const creatorPermissions = await getUserPermissions(eventData.user_id, eventData.artist_id, {
      skipCache: true,
    });
    if (creatorPermissions?.role !== 'admin') {
      insertPayload.is_public = false;
      insertPayload.is_featured = false;
      insertPayload.featured_at = null;
      insertPayload.highlight_image_url = null;
    }

    let { data: event, error: eventError } = await supabase
      .from("events")
      .insert(insertPayload)
      .select()
      .single();

    if (eventError && /is_public|is_featured|highlight_image_url|featured_at|PGRST204/i.test(eventError.message || "")) {
      const {
        is_public: _omitPublic,
        is_featured: _omitFeatured,
        highlight_image_url: _omitHighlight,
        featured_at: _omitFeaturedAt,
        ...withoutPublic
      } = insertPayload;
      const retry = await supabase.from("events").insert(withoutPublic).select().single();
      event = retry.data;
      eventError = retry.error;
    }

    if (eventError) {
      console.error("❌ Erro ao criar evento:", eventError);
      return { success: false, error: eventError.message };
    }

    console.log("✅ Evento criado com sucesso:", event.id);

    // O trigger notify_event_created() no banco já cria as notificações
    // automaticamente para todos os colaboradores (exceto o criador)

    // Enviar notificações push para todos os membros do artista (exceto o criador)
    await notifyArtistMembersPush(
      eventData.artist_id,
      eventData.user_id,
      "Novo Evento Criado",
      `${eventData.name} - ${new Date(eventData.event_date).toLocaleDateString("pt-BR")}`,
      {
        screen: "event",
        event_id: event.id,
      },
    );

    // Se há despesas, criar elas
    if (eventData.expenses && eventData.expenses.length > 0) {
      const expensesToInsert = eventData.expenses.map((expense) => ({
        event_id: event.id,
        name: expense.name,
        value: expense.value,
        receipt_url: expense.receipt_url || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      const { error: expensesError } = await supabase
        .from("event_expenses")
        .insert(expensesToInsert);

      if (expensesError) {
        // Se der erro nas despesas, deletar o evento criado
        await supabase.from("events").delete().eq("id", event.id);
        return { success: false, error: expensesError.message };
      }
    }

    void import("../agendaWidgetService").then((mod) => {
      void mod.refreshAgendaWidget(eventData.artist_id);
    });
    return { success: true, error: null, event };
  } catch {
    return { success: false, error: "Erro de conexão" };
  }
};

// Buscar eventos do artista (apenas ativos)
export const getEventsByArtist = async (
  artistId: string,
): Promise<{ success: boolean; error: string | null; events?: Event[] }> => {
  try {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .eq("artist_id", artistId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .order("event_date", { ascending: true });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, error: null, events: excludeFeedMarketplaceEvents(data) };
  } catch {
    return { success: false, error: "Erro de conexão" };
  }
};

export type RecentEventSuggestion = {
  name: string;
  value: number | null;
};

const rememberedAgendaEventsByArtist = new Map<string, Array<{ name?: string | null; value?: unknown; created_at?: string; event_date?: string }>>();

export function rememberAgendaEventsForSuggestions(
  artistId: string,
  events: Array<{ name?: string | null; value?: unknown; created_at?: string; event_date?: string }>,
) {
  if (!artistId) return;
  rememberedAgendaEventsByArtist.set(artistId, Array.isArray(events) ? events : []);
}

function toSuggestionValue(rawValue: unknown): number | null {
  if (typeof rawValue === "number") {
    return Number.isFinite(rawValue) ? rawValue : null;
  }
  if (rawValue == null || rawValue === "") return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueRecentSuggestions(
  rows: Array<{ name?: string | null; value?: unknown; created_at?: string; event_date?: string }>,
  limit: number,
): RecentEventSuggestion[] {
  const sorted = [...rows].sort((a, b) => {
    const aKey = String(a.created_at || a.event_date || "");
    const bKey = String(b.created_at || b.event_date || "");
    return bKey.localeCompare(aKey);
  });
  const seen = new Set<string>();
  const suggestions: RecentEventSuggestion[] = [];
  for (const row of sorted) {
    const name = String(row?.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      name,
      value: toSuggestionValue(row?.value),
    });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}

/** Últimos nomes de evento do artista (mais recentes primeiro), sem repetir. */
export function getRecentEventNameSuggestionsSync(
  artistId: string,
  limit = 8,
): RecentEventSuggestion[] {
  return uniqueRecentSuggestions(
    rememberedAgendaEventsByArtist.get(artistId) || [],
    limit,
  );
}

export const getRecentEventNameSuggestions = async (
  artistId: string,
  limit = 8,
): Promise<{ suggestions: RecentEventSuggestion[]; error: string | null }> => {
  try {
    const collected: Array<{
      name?: string | null;
      value?: unknown;
      created_at?: string;
      event_date?: string;
    }> = [...(rememberedAgendaEventsByArtist.get(artistId) || [])];

    const now = new Date();
    for (let i = 0; i < 6; i += 1) {
      const cursor = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const cached = await cacheService.getEventsData<typeof collected>(
        artistId,
        cursor.getFullYear(),
        cursor.getMonth(),
      );
      if (cached?.length) collected.push(...cached);
    }

    if (collected.length > 0) {
      const fromLocal = uniqueRecentSuggestions(collected, limit);
      if (fromLocal.length > 0) {
        return { suggestions: fromLocal, error: null };
      }
    }

    const byRole = await getEventsByArtistWithRole(artistId);
    if (!byRole.error && byRole.events && byRole.events.length > 0) {
      return {
        suggestions: uniqueRecentSuggestions(byRole.events, limit),
        error: null,
      };
    }

    const { data, error } = await supabase
      .from("events")
      .select("name, value, event_date, created_at, feed_tipo, ativo")
      .eq("artist_id", artistId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .order("event_date", { ascending: false })
      .limit(80);

    if (error) {
      return { suggestions: uniqueRecentSuggestions(collected, limit), error: error.message };
    }

    return {
      suggestions: uniqueRecentSuggestions(
        [...collected, ...excludeFeedMarketplaceEvents(data || [])],
        limit,
      ),
      error: null,
    };
  } catch {
    return {
      suggestions: uniqueRecentSuggestions(
        rememberedAgendaEventsByArtist.get(artistId) || [],
        limit,
      ),
      error: "Erro de conexão",
    };
  }
};

// Buscar eventos por mês
export const getEventsByMonth = async (
  artistId: string,
  year: number,
  month: number,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; error: string | null; events?: Event[]; aborted?: boolean }> => {
  try {
    const { startDate, endDate } = calendarMonthBounds(year, month);

    console.log(
      "getEventsByMonth: Buscando eventos para artista:",
      artistId,
      "De:",
      startDate,
      "Até:",
      endDate,
    );

    const loaded = await fetchArtistAgendaEvents(artistId, abortSignal);
    if (loaded.aborted) {
      return { success: false, error: null, aborted: true };
    }
    if (loaded.error) {
      return { success: false, error: loaded.error };
    }

    const events = loaded.events.filter((event) => inDateRange(event.event_date, startDate, endDate));
    return { success: true, error: null, events };
  } catch (error) {
    if (abortSignal?.aborted || isAbortError(error)) {
      return { success: false, error: null, aborted: true };
    }
    return { success: false, error: "Erro de conexão" };
  }
};

/** Eventos ativos do artista entre 1º de jan e 31 de dezem do ano (inclusive). */
export const getEventsByYear = async (
  artistId: string,
  year: number,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; error: string | null; events?: Event[]; aborted?: boolean }> => {
  try {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const loaded = await fetchArtistAgendaEvents(artistId, abortSignal);
    if (loaded.aborted) {
      return { success: false, error: null, aborted: true };
    }
    if (loaded.error) {
      return { success: false, error: loaded.error };
    }

    const events = loaded.events.filter((event) => inDateRange(event.event_date, startDate, endDate));
    return { success: true, error: null, events };
  } catch (error) {
    if (abortSignal?.aborted || isAbortError(error)) {
      return { success: false, error: null, aborted: true };
    }
    return { success: false, error: "Erro de conexão" };
  }
};

/** Eventos ativos do artista entre `startDate` e `endDate` (inclusive), formato YYYY-MM-DD. */
export const getEventsByDateRange = async (
  artistId: string,
  startDate: string,
  endDate: string,
): Promise<{ success: boolean; error: string | null; events?: Event[] }> => {
  try {
    const loaded = await fetchArtistAgendaEvents(artistId);
    if (loaded.error) {
      return { success: false, error: loaded.error };
    }
    const events = loaded.events.filter((event) => inDateRange(event.event_date, startDate, endDate));
    return { success: true, error: null, events };
  } catch {
    return { success: false, error: "Erro de conexão" };
  }
};

// Buscar evento por ID (só retorna se ativo = true; evento "deletado" = não encontrado)
export const getEventById = async (
  eventId: string,
): Promise<{ success: boolean; error: string | null; event?: Event }> => {
  try {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    if (!data) {
      return { success: false, error: "Evento não encontrado" };
    }

    return { success: true, error: null, event: data };
  } catch {
    return { success: false, error: "Erro de conexão" };
  }
};

// Atualizar evento
export const updateEvent = async (
  eventId: string,
  eventData: UpdateEventData,
  userId?: string,
): Promise<{ success: boolean; error: string | null; event?: Event }> => {
  try {
    // Buscar o evento antes de atualizar para obter informações necessárias
    const eventResult = await getEventById(eventId);
    if (!eventResult.success || !eventResult.event) {
      return { success: false, error: "Evento não encontrado" };
    }

    if (eventResult.event.convite_participacao_id) {
      const { data: conviteRow } = await supabase
        .from("convite_participacao_evento")
        .select("evento_origem_id, artista_que_convidou_id")
        .eq("id", eventResult.event.convite_participacao_id)
        .maybeSingle();
      if (eventoEhCopiaDoConvidado(eventResult.event, conviteRow)) {
        return {
          success: false,
          error:
            "Eventos vindos de convite de participação não podem ser alterados após o aceite.",
        };
      }
    }

    if (!userId) {
      return { success: false, error: "Usuário não autenticado" };
    }

    const permissions = await getUserPermissions(
      userId,
      eventResult.event.artist_id,
      { skipCache: true },
    );
    const canEdit =
      permissions?.permissions.canEditEvents ||
      (permissions?.role === "vendedor" &&
        eventResult.event.created_by === userId);
    if (!canEdit) {
      return { success: false, error: "Sem permissão para editar este evento" };
    }

    const patch: Record<string, unknown> = {
      ...eventData,
      updated_by: userId ?? eventData.updated_by ?? null,
      updated_at: new Date().toISOString(),
    };
    if (eventData.confirmed === false) {
      patch.is_public = false;
      patch.is_featured = false;
      patch.featured_at = null;
    } else if (eventData.confirmed === true) {
      if (eventData.is_featured != null) {
        patch.is_featured = Boolean(eventData.is_featured);
      }
      if (eventData.is_featured) {
        patch.is_public = true;
        if (!eventResult.event.is_featured) {
          patch.featured_at = new Date().toISOString();
        }
      } else if (eventData.is_featured === false) {
        patch.featured_at = null;
      }
      if (!eventData.is_featured && eventData.is_public != null) {
        patch.is_public = Boolean(eventData.is_public);
      }
    }

    if (permissions?.role !== 'admin') {
      delete patch.is_public;
      delete patch.is_featured;
      delete patch.highlight_image_url;
      delete patch.featured_at;
    }

    let { data, error } = await supabase
      .from("events")
      .update(patch)
      .eq("id", eventId)
      .select()
      .single();

    if (error && /is_public|is_featured|highlight_image_url|featured_at|PGRST204/i.test(error.message || "")) {
      const {
        is_public: _omitPublic,
        is_featured: _omitFeatured,
        highlight_image_url: _omitHighlight,
        featured_at: _omitFeaturedAt,
        ...withoutPublic
      } = patch;
      const retry = await supabase
        .from("events")
        .update(withoutPublic)
        .eq("id", eventId)
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      if (error.message?.includes("JSON object")) {
        return {
          success: false,
          error:
            "Não foi possível atualizar o evento. Verifique suas permissões ou se o evento existe.",
        };
      }
      return { success: false, error: error.message };
    }

    if (!data) {
      return {
        success: false,
        error:
          "Evento não encontrado ou você não possui permissão para editá-lo.",
      };
    }

    // Enviar notificações push para todos os membros do artista (exceto quem editou)
    if (userId) {
      await notifyArtistMembersPush(
        data.artist_id,
        userId,
        "Evento Atualizado",
        `${data.name} foi atualizado`,
        {
          screen: "event",
          event_id: eventId,
        },
      );
    }

    void import("../agendaWidgetService").then((mod) => {
      void mod.refreshAgendaWidget(eventResult.event.artist_id);
    });
    return { success: true, error: null, event: data };
  } catch {
    return { success: false, error: "Erro de conexão" };
  }
};

// Deletar evento (soft delete: ativo = false, update_ativo = agora)
export const deleteEvent = async (
  eventId: string,
  userId?: string,
): Promise<{ success: boolean; error: string | null }> => {
  try {
    const { data: eventRow, error: fetchError } = await supabase
      .from("events")
      .select("id, name, artist_id, created_by")
      .eq("id", eventId)
      .maybeSingle();

    if (fetchError || !eventRow) {
      return { success: false, error: "Evento não encontrado" };
    }

    const eventName = eventRow.name;
    const artistId = eventRow.artist_id;
    if (!userId) {
      return { success: false, error: "Usuário não autenticado" };
    }

    const permissions = await getUserPermissions(userId, artistId);
    const canDelete =
      permissions?.permissions.canDeleteEvents ||
      (permissions?.role === "vendedor" && eventRow.created_by === userId);
    if (!canDelete) {
      return {
        success: false,
        error: "Sem permissão para deletar este evento",
      };
    }

    const now = new Date().toISOString();

    const { error } = await supabase
      .from("events")
      .update({
        ativo: false,
        update_ativo: now,
        updated_at: now,
        updated_by: userId ?? null,
      })
      .eq("id", eventId);

    if (error) {
      return { success: false, error: error.message };
    }

    if (userId) {
      await notifyArtistMembersPush(
        artistId,
        userId,
        "Evento Deletado",
        `${eventName} foi deletado`,
        {
          screen: "events",
          event_id: eventId,
        },
      );
    }

    void import("../agendaWidgetService").then((mod) => {
      void mod.refreshAgendaWidget(artistId);
    });
    return { success: true, error: null };
  } catch {
    return { success: false, error: "Erro de conexão" };
  }
};

// =====================================================
// FUNÇÕES COM VERIFICAÇÃO DE PERMISSÕES
// =====================================================

// Buscar eventos com verificação de permissões
export const getEventsWithPermissions = async (
  artistId: string,
  userId: string,
): Promise<{ events: Event[] | null; error: string | null }> => {
  try {
    // Verificar se o usuário tem permissão para visualizar eventos
    const canView = await hasPermission(userId, artistId, "canViewEvents");
    if (!canView) {
      return { events: null, error: "Sem permissão para visualizar eventos" };
    }

    const { data: userRes } = await supabase.auth.getUser();
    let query = supabase
      .from("events")
      .select(EVENT_AGENDA_SELECT)
      .eq("artist_id", artistId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .order("event_date", { ascending: false });
    const { data, error } = await query;

    if (error) {
      console.error("Erro ao buscar eventos:", error);
      return { events: null, error: error.message };
    }

    const role = (await getUserPermissions(userId, artistId))?.role;
    const events = excludeFeedMarketplaceEvents(
      ((data || []) as Event[]).map((row) =>
        maskEventValueForRole(row, role, userRes.user?.id),
      ),
    );
    return { events, error: null };
  } catch (error) {
    console.error("Erro ao buscar eventos:", error);
    return { events: null, error: "Erro ao buscar eventos" };
  }
};

// Criar evento com verificação de permissões
export const createEventWithPermissions = async (
  eventData: CreateEventData,
  userId: string,
): Promise<{ success: boolean; error: string | null; event?: Event }> => {
  try {
    // Verificar se o usuário tem permissão para criar eventos
    const canCreate = await hasPermission(
      userId,
      eventData.artist_id,
      "canCreateEvents",
    );
    if (!canCreate) {
      return { success: false, error: "Sem permissão para criar eventos" };
    }

    return await createEvent(eventData);
  } catch (error) {
    console.error("Erro ao criar evento:", error);
    return { success: false, error: "Erro ao criar evento" };
  }
};

// Atualizar evento com verificação de permissões
export const updateEventWithPermissions = async (
  eventId: string,
  eventData: UpdateEventData,
  userId: string,
): Promise<{ success: boolean; error: string | null }> => {
  try {
    // Primeiro, buscar o evento para obter o artist_id
    const eventResult = await getEventById(eventId);
    if (!eventResult.success || !eventResult.event) {
      return { success: false, error: "Evento não encontrado" };
    }

    // Verificar se o usuário tem permissão para editar eventos
    const permissions = await getUserPermissions(
      userId,
      eventResult.event.artist_id,
    );
    const canEdit =
      permissions?.permissions.canEditEvents ||
      (permissions?.role === "vendedor" &&
        eventResult.event.created_by === userId);
    if (!canEdit) {
      return { success: false, error: "Sem permissão para editar eventos" };
    }

    // Atualizar o evento (passa userId para enviar notificações)
    const result = await updateEvent(eventId, eventData, userId);

    // O trigger notify_event_updated() no banco deve usar NEW.updated_by (não created_by)
    // em from_user_id, senão a notificação aparece como se o criador tivesse editado.

    return result;
  } catch (error) {
    console.error("Erro ao atualizar evento:", error);
    return { success: false, error: "Erro ao atualizar evento" };
  }
};

// Deletar evento com verificação de permissões
export const deleteEventWithPermissions = async (
  eventId: string,
  userId: string,
): Promise<{ success: boolean; error: string | null }> => {
  try {
    // Primeiro, buscar o evento para obter o artist_id
    const eventResult = await getEventById(eventId);
    if (!eventResult.success || !eventResult.event) {
      return { success: false, error: "Evento não encontrado" };
    }

    // Verificar se o usuário tem permissão para deletar eventos
    const permissions = await getUserPermissions(
      userId,
      eventResult.event.artist_id,
    );
    const canDelete =
      permissions?.permissions.canDeleteEvents ||
      (permissions?.role === "vendedor" &&
        eventResult.event.created_by === userId);
    if (!canDelete) {
      return { success: false, error: "Sem permissão para deletar eventos" };
    }

    // Deletar o evento (passa userId para enviar notificações)
    return await deleteEvent(eventId, userId);
  } catch (error) {
    console.error("Erro ao deletar evento:", error);
    return { success: false, error: "Erro ao deletar evento" };
  }
};

// Buscar evento por ID com verificação de permissões
export const getEventByIdWithPermissions = async (
  eventId: string,
  userId: string,
): Promise<{ event: Event | null; error: string | null }> => {
  try {
    // Primeiro, buscar o evento
    const eventResult = await getEventById(eventId);
    if (!eventResult.success || !eventResult.event) {
      return { event: null, error: "Evento não encontrado" };
    }

    // Verificar se o usuário tem permissão para visualizar eventos
    const canView = await hasPermission(
      userId,
      eventResult.event.artist_id,
      "canViewEvents",
    );
    if (!canView) {
      return {
        event: null,
        error: "Sem permissão para visualizar este evento",
      };
    }

    // Verificar se o usuário pode ver valores financeiros
    const canViewFinancials = await hasPermission(
      userId,
      eventResult.event.artist_id,
      "canViewFinancials",
    );

    // Vendedor: vê o valor apenas do evento que ele mesmo criou
    const userPermission = await getUserPermissions(
      userId,
      eventResult.event.artist_id,
    );
    const isOwnEventForVendedor =
      userPermission?.role === "vendedor" &&
      userPermission.permissions.canViewOwnEventValue &&
      eventResult.event.created_by === userId;

    // Se não pode ver finanças (e não é o próprio evento do vendedor), remover o valor
    if (!canViewFinancials && !isOwnEventForVendedor) {
      eventResult.event.value = undefined;
    }

    return { event: eventResult.event, error: null };
  } catch (error) {
    console.error("Erro ao buscar evento:", error);
    return { event: null, error: "Erro ao buscar evento" };
  }
};

// =====================================================
// FUNÇÕES RPC COM FILTRAGEM POR ROLE
// Usam as funções do banco que automaticamente ocultam
// colunas sensíveis (como 'value') para viewers
// =====================================================

export interface EventWithRole {
  id: string;
  artist_id: string;
  created_by: string; // Quem criou o evento
  name: string;
  description?: string;
  viewer_description?: string | null;
  event_date: string;
  start_time: string;
  end_time: string;
  value?: number | null; // NULL para viewer
  city?: string;
  state_uf?: string | null;
  contractor_phone?: string;
  confirmed: boolean;
  tag: "ensaio" | "evento" | "reunião";
  feed_tipo?: "disponivel" | "demanda" | null;
  created_at: string;
  updated_at: string;
  user_role?: string; // Role do usuário atual para este artista
}

// Buscar eventos de um artista com filtragem automática por role
export const getEventsByArtistWithRole = async (
  artistId: string,
  abortSignal?: AbortSignal,
): Promise<{
  events: EventWithRole[] | null;
  error: string | null;
  errorCode?: string;
  aborted?: boolean;
}> => {
  try {
    console.log(
      "🔐 Buscando eventos com filtragem por role para artista:",
      artistId,
    );

    const { data: userRes, error: userError } = await supabase.auth.getUser();
    if (userError || !userRes.user) {
      return { events: null, error: "Usuário não autenticado" };
    }

    const permissions = await getUserPermissions(userRes.user.id, artistId);
    if (!permissions) {
      return {
        events: null,
        error: "Usuário não tem acesso a este artista",
        errorCode: "P0001",
      };
    }

    let query = supabase
      .from("events")
      .select(EVENT_AGENDA_SELECT)
      .eq("artist_id", artistId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .order("event_date", { ascending: false })
      .order("start_time", { ascending: false });
    if (abortSignal) query = query.abortSignal(abortSignal);
    const { data, error } = await query;

    if (abortSignal?.aborted || isAbortError(error)) {
      return { events: null, error: null, aborted: true };
    }
    if (error) {
      console.error("❌ Erro ao buscar eventos com role:", error);
      return {
        events: null,
        error: error.message,
        errorCode: error.code || undefined,
      };
    }

    const events = excludeFeedMarketplaceEvents(
      ((data || []) as EventWithRole[]).map((row) => ({
        ...maskEventValueForRole(row, permissions.role, userRes.user.id),
        user_role: permissions.role,
      })),
    );
    console.log("✅ Eventos carregados com filtragem:", events.length);
    void import("../agendaWidgetService").then((mod) => {
      mod.publishAgendaWidget(events);
    });
    return { events, error: null };
  } catch (error: any) {
    if (abortSignal?.aborted || isAbortError(error)) {
      return { events: null, error: null, aborted: true };
    }
    console.error("❌ Erro ao buscar eventos com role:", error);
    return {
      events: null,
      error: error?.message || "Erro ao buscar eventos",
      errorCode: error?.code,
    };
  }
};

function isAgendaRpcMissing(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes("could not find the function") ||
    text.includes("schema cache") ||
    (text.includes("function") && text.includes("does not exist"))
  );
}

export interface AgendaConvidado {
  id: string;
  name: string;
  profile_url: string | null;
  isHost: boolean;
}

export interface AgendaMesCollab {
  participantes: Record<string, AgendaConvidado[]>;
  parceiros: Record<string, { name: string; profile_url: string | null }>;
  ciclos: Record<string, string>;
  conviteIdByEventId: Record<string, string>;
  ownerOriginEventIds: Record<string, true>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapAgendaMesPayload(payload: unknown): {
  events: EventWithRole[];
  collab: AgendaMesCollab | null;
} {
  const body = asRecord(payload);
  const role = normalizeArtistMemberRole(String(body.role || ""));
  const rows = Array.isArray(body.events) ? body.events : [];
  const events = excludeFeedMarketplaceEvents(
    rows.map((row) => {
      const event = row as EventWithRole;
      const rawValue = event.value as unknown;
      const value =
        rawValue == null || rawValue === ""
          ? null
          : Number.isFinite(Number(rawValue))
            ? Number(rawValue)
            : null;
      return {
        ...event,
        event_date: toCalendarYmd(event.event_date) || String(event.event_date || ""),
        value,
        user_role: role,
      };
    }),
  );

  if (body.convidados_inclusos !== true) {
    return { events, collab: null };
  }

  const participantes: AgendaMesCollab["participantes"] = {};
  Object.entries(asRecord(body.participantes)).forEach(([eventId, list]) => {
    if (!Array.isArray(list)) return;
    participantes[eventId] = list
      .map((item) => {
        const row = asRecord(item);
        const id = String(row.id || "");
        if (!id) return null;
        return {
          id,
          name: String(row.name || "Artista"),
          profile_url:
            row.profile_url != null && String(row.profile_url).trim()
              ? String(row.profile_url)
              : null,
          isHost: row.isHost === true,
        };
      })
      .filter((item): item is AgendaConvidado => item != null);
  });

  const parceiros: AgendaMesCollab["parceiros"] = {};
  Object.entries(asRecord(body.parceiros)).forEach(([conviteId, item]) => {
    const row = asRecord(item);
    parceiros[conviteId] = {
      name: String(row.name || "Artista"),
      profile_url:
        row.profile_url != null && String(row.profile_url).trim()
          ? String(row.profile_url)
          : null,
    };
  });

  const ciclos: Record<string, string> = {};
  Object.entries(asRecord(body.ciclos)).forEach(([conviteId, status]) => {
    if (status != null && String(status).trim()) ciclos[conviteId] = String(status);
  });

  const conviteIdByEventId: Record<string, string> = {};
  Object.entries(asRecord(body.copias)).forEach(([eventId, conviteId]) => {
    if (conviteId != null && String(conviteId).trim()) {
      conviteIdByEventId[eventId] = String(conviteId);
    }
  });

  const ownerOriginEventIds: Record<string, true> = {};
  if (Array.isArray(body.origens_do_dono)) {
    body.origens_do_dono.forEach((id) => {
      if (id != null && String(id).trim()) ownerOriginEventIds[String(id)] = true;
    });
  }

  return {
    events,
    collab: {
      participantes,
      parceiros,
      ciclos,
      conviteIdByEventId,
      ownerOriginEventIds,
    },
  };
}

// Buscar eventos de um mês específico com filtragem por role.
// Uma função no banco devolve papel e eventos. Se ela ainda não existir, usa as consultas antigas.
export const getEventsByMonthWithRole = async (
  artistId: string,
  year: number,
  month: number,
  abortSignal?: AbortSignal,
): Promise<{
  success: boolean;
  error: string | null;
  events?: EventWithRole[];
  collab?: AgendaMesCollab | null;
  errorCode?: string;
  aborted?: boolean;
}> => {
  try {
    const { startDate, endDate } = calendarMonthBounds(year, month);

    let rpc = supabase.rpc("rpc_app_agenda_mes", {
      p_artista_id: artistId,
      p_inicio: startDate,
      p_fim: endDate,
    });
    if (abortSignal) rpc = rpc.abortSignal(abortSignal);
    const rpcRes = await rpc;
    if (abortSignal?.aborted || isAbortError(rpcRes.error)) {
      return { success: false, error: null, aborted: true };
    }
    if (!rpcRes.error) {
      const mapped = mapAgendaMesPayload(rpcRes.data);
      return {
        success: true,
        error: null,
        events: mapped.events,
        collab: mapped.collab,
      };
    }
    if (!isAgendaRpcMissing(rpcRes.error.message)) {
      const denied =
        rpcRes.error.code === "P0001" ||
        (rpcRes.error.message || "").includes("não tem acesso");
      return {
        success: false,
        error: rpcRes.error.message,
        errorCode: denied ? "P0001" : rpcRes.error.code || undefined,
      };
    }

    const { data: userRes, error: userError } = await supabase.auth.getUser();
    if (userError || !userRes.user) {
      return { success: false, error: "Usuário não autenticado" };
    }

    let eventsQuery = supabase
      .from("events")
      .select(EVENT_AGENDA_SELECT)
      .eq("artist_id", artistId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .gte("event_date", startDate)
      .lte("event_date", endDate)
      .order("event_date", { ascending: true })
      .order("start_time", { ascending: true });
    if (abortSignal) eventsQuery = eventsQuery.abortSignal(abortSignal);

    const [permissions, eventsRes] = await Promise.all([
      getUserPermissions(userRes.user.id, artistId),
      eventsQuery,
    ]);

    if (abortSignal?.aborted || isAbortError(eventsRes.error)) {
      return { success: false, error: null, aborted: true };
    }
    if (!permissions) {
      return {
        success: false,
        error: "Usuário não tem acesso a este artista",
        errorCode: "P0001",
      };
    }
    if (eventsRes.error) {
      return {
        success: false,
        error: eventsRes.error.message,
        errorCode: eventsRes.error.code || undefined,
      };
    }

    const filteredEvents = excludeFeedMarketplaceEvents(
      ((eventsRes.data || []) as EventWithRole[]).map((row) => ({
        ...maskEventValueForRole(row, permissions.role, userRes.user.id),
        user_role: permissions.role,
      })),
    );
    return { success: true, error: null, events: filteredEvents };
  } catch (error: any) {
    if (abortSignal?.aborted || isAbortError(error)) {
      return { success: false, error: null, aborted: true };
    }
    console.error("❌ Erro ao buscar eventos por mês:", error);
    return {
      success: false,
      error: error?.message || "Erro de conexão",
      errorCode: error?.code,
    };
  }
};

// Buscar um evento específico com filtragem por role
export const getEventByIdWithRole = async (
  eventId: string,
): Promise<{ event: EventWithRole | null; error: string | null }> => {
  try {
    console.log("🔐 Buscando evento por ID com role:", eventId);

    const { data: userRes, error: userError } = await supabase.auth.getUser();
    if (userError || !userRes.user) {
      return { event: null, error: "Usuário não autenticado" };
    }

    const { data, error } = await supabase
      .from("events")
      .select(EVENT_AGENDA_SELECT)
      .eq("id", eventId)
      .eq("ativo", true)
      .is("feed_tipo", null)
      .maybeSingle();

    if (error) {
      console.error("❌ Erro ao buscar evento:", error);
      return { event: null, error: error.message };
    }
    if (!data) {
      return { event: null, error: "Evento não encontrado" };
    }

    const permissions = await getUserPermissions(userRes.user.id, data.artist_id);
    if (!permissions) {
      return { event: null, error: "Usuário não tem acesso a este evento" };
    }

    const event = maskEventValueForRole(
      { ...(data as EventWithRole), user_role: permissions.role },
      permissions.role,
      userRes.user.id,
    );
    console.log("✅ Evento carregado:", event.id);
    return { event, error: null };
  } catch (error) {
    console.error("❌ Erro ao buscar evento:", error);
    return { event: null, error: "Erro ao buscar evento" };
  }
};

export interface PublicAgendaEvent {
  id: string;
  name: string;
  event_date: string;
  start_time: string;
  end_time: string;
  city?: string | null;
  state_uf?: string | null;
  tag?: string | null;
}

export interface FeaturedShow {
  id: string;
  name: string;
  event_date: string;
  start_time: string;
  end_time: string;
  city?: string | null;
  state_uf?: string | null;
  tag?: string | null;
  highlight_image_url?: string | null;
  featured_at?: string | null;
}

export const listarAgendaPublicaArtista = async (
  artistId: string,
): Promise<{ events: PublicAgendaEvent[]; error: string | null }> => {
  try {
    const { data, error } = await supabase.rpc("listar_agenda_publica_artista", {
      p_artist_id: artistId,
    });
    if (error) {
      console.warn("Agenda pública indisponível:", error.message);
      return { events: [], error: error.message };
    }
    const events = ((data ?? []) as PublicAgendaEvent[]).map((item) => ({
      ...item,
      event_date: String(item.event_date || "").slice(0, 10),
      start_time: String(item.start_time || "").slice(0, 5),
      end_time: String(item.end_time || "").slice(0, 5),
    }));
    return { events, error: null };
  } catch (error: any) {
    return { events: [], error: error?.message || "Erro ao carregar agenda pública" };
  }
};

export const listarShowsDestaqueArtista = async (
  artistId: string,
): Promise<{ shows: FeaturedShow[]; error: string | null }> => {
  try {
    const { data, error } = await supabase.rpc("listar_shows_destaque_artista", {
      p_artist_id: artistId,
    });
    if (error) {
      console.warn("Shows em destaque indisponíveis:", error.message);
      return { shows: [], error: error.message };
    }
    const shows = ((data ?? []) as FeaturedShow[])
      .map((item) => ({
        ...item,
        event_date: String(item.event_date || "").slice(0, 10),
        start_time: String(item.start_time || "").slice(0, 5),
        end_time: String(item.end_time || "").slice(0, 5),
        highlight_image_url: item.highlight_image_url?.trim() || null,
        featured_at: item.featured_at || null,
      }))
      .filter((item) => !isEventDateAlreadyPast(item.event_date))
      .sort((a, b) => {
        const at = a.featured_at || "";
        const bt = b.featured_at || "";
        if (at !== bt) return bt.localeCompare(at);
        const dateCmp = a.event_date.localeCompare(b.event_date);
        if (dateCmp !== 0) return dateCmp;
        return String(a.start_time || "").localeCompare(String(b.start_time || ""));
      });
    return { shows, error: null };
  } catch (error: any) {
    return { shows: [], error: error?.message || "Erro ao carregar shows em destaque" };
  }
};

export const definirShowDestaquePrincipal = async (
  eventId: string,
): Promise<{ success: boolean; error: string | null }> => {
  try {
    const { error } = await supabase.rpc("definir_show_destaque_principal", {
      p_event_id: eventId,
    });
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true, error: null };
  } catch (error: any) {
    return { success: false, error: error?.message || "Erro ao definir destaque principal" };
  }
};
