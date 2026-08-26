import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const defaultLoginDomain = "lojaosuper20cupira.com.br";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Método não permitido." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: "Função sem variáveis do Supabase configuradas." }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ ok: false, error: "Faça login como administrador." }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: requesterData, error: requesterError } = await adminClient.auth.getUser(token);
    if (requesterError || !requesterData.user) {
      return json({ ok: false, error: "Sessão inválida. Entre novamente." }, 401);
    }

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", requesterData.user.id)
      .single();

    if (profileError || profile?.role !== "admin") {
      return json({ ok: false, error: "Somente administrador pode cadastrar conferente." }, 403);
    }

    const body = await req.json();
    const username = safeLoginName(body.username);
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();

    if (!username) return json({ ok: false, error: "Informe o usuário do conferente." }, 400);
    if (password.length < 6) return json({ ok: false, error: "A senha precisa ter pelo menos 6 caracteres." }, 400);

    const email = `${username}@${defaultLoginDomain}`;
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || username }
    });

    if (createError) {
      return json({ ok: false, error: createError.message }, 400);
    }

    const user = created.user;
    if (!user) return json({ ok: false, error: "Usuário não foi criado." }, 500);

    const { error: profileUpsertError } = await adminClient
      .from("profiles")
      .upsert({ id: user.id, email, role: "conferente" }, { onConflict: "id" });

    if (profileUpsertError) {
      return json({ ok: false, error: profileUpsertError.message }, 400);
    }

    return json({ ok: true, email, user_id: user.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    return json({ ok: false, error: message }, 500);
  }
});

function safeLoginName(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .toLowerCase();
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
