import { NextResponse } from "next/server";
import { createServerSupabase, createAdminSupabase } from "@/lib/supabase/server";

function isScraperRequest(request) {
  const auth = request.headers.get("authorization");
  return !!process.env.SCRAPER_API_KEY && auth === `Bearer ${process.env.SCRAPER_API_KEY}`;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const storeName = searchParams.get("store_name");
  const supabase = createServerSupabase();

  let query = supabase
    .from("naver_bookings")
    .select("*")
    .order("received_at", { ascending: false });

  if (storeName) query = query.eq("store_name", storeName);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bookings: data });
}

export async function POST(request) {
  const isScraper = isScraperRequest(request);
  const supabase = isScraper ? createAdminSupabase() : createServerSupabase();

  const body = await request.json();
  const { store_name, booking_id, customer_name, phone, use_datetime, status, raw } = body;

  if (!store_name || !booking_id) {
    return NextResponse.json(
      { error: "store_name, booking_id are required" },
      { status: 400 }
    );
  }

  const payload = {
    store_name,
    booking_id: String(booking_id),
    customer_name: customer_name || null,
    phone: phone || null,
    use_datetime: use_datetime || null,
    status: status || null,
    raw: raw || null,
  };

  // booking_id 기준으로 이미 있으면 갱신, 없으면 새로 생성 (동일 예약이 중복 전송돼도 안전)
  const { data: existing, error: findError } = await supabase
    .from("naver_bookings")
    .select("id")
    .eq("booking_id", payload.booking_id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json({ error: findError.message }, { status: 500 });
  }

  if (existing) {
    const { data, error } = await supabase
      .from("naver_bookings")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ booking: data });
  } else {
    const { data, error } = await supabase
      .from("naver_bookings")
      .insert(payload)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ booking: data });
  }
}
