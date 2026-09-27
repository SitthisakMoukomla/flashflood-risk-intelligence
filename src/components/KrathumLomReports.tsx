"use client";

// "รายงานเจ้าหน้าที่" — the layer of points municipal staff add themselves.
//
// Everything here is what a person saw, not what an instrument or a
// satellite measured, so it keeps its own symbol (a pin with a flag) and
// its own tab, and every point names who reported it and when.
//
// Flow: enter the shared staff code once (kept in localStorage) → the layer
// loads → "เพิ่มจุด" arms the map → one tap places the pin → the form saves.
// Photos are shrunk in the browser to ≤1280 px before upload.

import { Camera, Check, CheckCircle2, Crosshair, Flag, KeyRound, LogOut, MapPin, Trash2, X } from "lucide-react";
import type * as Leaflet from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REPORT_KINDS, type Report, type ReportInput, type ReportKind } from "@/lib/reports";

const API = "/api/krathumlom/reports";
const PHOTO_API = "/api/krathumlom/photos";
const CODE_KEY = "kl_staff_code";
const NAME_KEY = "kl_staff_name";

type Draft = {
  lat: number;
  lng: number;
  kind: ReportKind;
  title: string;
  note: string;
  depth_cm: string;
  observed_at: string; // datetime-local value
  reported_by: string;
  photoFile: File | null;
};

function fmt(iso: string): string {
  try {
    return new Intl.DateTimeFormat("th-TH", {
      day: "numeric",
      month: "short",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Bangkok",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Now, as a datetime-local string in Bangkok time. */
function nowLocal(): string {
  const p = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bangkok",
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** datetime-local (Bangkok) → ISO. */
function localToIso(v: string): string {
  return new Date(`${v}:00+07:00`).toISOString();
}

/** Downscale a photo in the browser so uploads stay small on a phone connection. */
async function shrinkPhoto(file: File, maxPx = 1280): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.type === "image/jpeg" && file.size < 600_000) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.82),
  );
}

export function pinSvg(color: string, resolved: boolean): string {
  // A flag on a pin — deliberately unlike the round gauge dots.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="30" viewBox="0 0 26 30">
    <path d="M6 29 V4" stroke="#07131a" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M6 29 V4" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M7 4 h14 l-4 5 4 5 h-14 z" fill="${resolved ? "#6f8e92" : color}" stroke="#07131a" stroke-width="1.4" stroke-linejoin="round" ${resolved ? 'opacity="0.75"' : ""}/>
  </svg>`;
}

export function ReportsPanel({
  L,
  map,
  active,
  onCountChange,
  visible = true,
}: {
  L: typeof Leaflet | null;
  map: Leaflet.Map | null;
  /** Whether this tab is the one on screen (the map layer stays either way). */
  active: boolean;
  onCountChange?: (open: number) => void;
  /** Layer toggle from the map's layer control. */
  visible?: boolean;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const layerRef = useRef<Leaflet.LayerGroup | null>(null);
  const draftPinRef = useRef<Leaflet.Marker | null>(null);

  useEffect(() => {
    try {
      const c = localStorage.getItem(CODE_KEY);
      if (c) {
        const t = window.setTimeout(() => setCode(c), 0);
        return () => window.clearTimeout(t);
      }
    } catch {
      /* private mode */
    }
  }, []);

  const headers = useCallback(
    (extra?: Record<string, string>) => ({ "x-staff-code": code ?? "", ...(extra ?? {}) }),
    [code],
  );

  const load = useCallback(async () => {
    if (!code) return;
    try {
      const r = await fetch(API, { headers: headers(), cache: "no-store" });
      const j = (await r.json()) as { reports?: Report[]; error?: string };
      if (!r.ok) {
        if (r.status === 401) {
          setCode(null);
          try {
            localStorage.removeItem(CODE_KEY);
          } catch {
            /* ignore */
          }
        }
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setReports(j.reports ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, [code, headers]);

  useEffect(() => {
    if (!code) return;
    const t = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), 2 * 60_000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(id);
    };
  }, [code, load]);

  useEffect(() => {
    onCountChange?.(reports?.filter((r) => r.status === "open").length ?? 0);
  }, [reports, onCountChange]);

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    const c = codeInput.trim();
    if (!c) return;
    try {
      localStorage.setItem(CODE_KEY, c);
    } catch {
      /* ignore */
    }
    setCodeInput("");
    setCode(c);
  };
  const logout = () => {
    try {
      localStorage.removeItem(CODE_KEY);
    } catch {
      /* ignore */
    }
    setCode(null);
    setReports(null);
    setDraft(null);
    setArming(false);
  };

  // ── Map layer: one flag pin per report
  useEffect(() => {
    if (!L || !map) return;
    layerRef.current?.removeFrom(map);
    layerRef.current = null;
    if (!reports || !visible) return;
    const g = L.layerGroup();
    for (const r of reports) {
      if (r.status === "resolved" && !showResolved) continue;
      const icon = L.divIcon({
        className: "kl-report-pin",
        html: pinSvg(REPORT_KINDS[r.kind].color, r.status === "resolved"),
        iconSize: [26, 30],
        iconAnchor: [6, 29],
        tooltipAnchor: [8, -20],
      });
      L.marker([r.lat, r.lng], { icon, zIndexOffset: 500 })
        .bindTooltip(
          `<b>${escapeHtml(r.title)}</b> · ${REPORT_KINDS[r.kind].label}${r.depth_cm !== null ? ` · ${r.depth_cm} ซม.` : ""}<br/><span style="opacity:.75">${escapeHtml(r.reported_by)} · ${fmt(r.observed_at)}</span>`,
          { direction: "top" },
        )
        .on("click", () => setSelected(r.id))
        .addTo(g);
    }
    g.addTo(map);
    layerRef.current = g;
    return () => {
      g.removeFrom(map);
    };
  }, [L, map, reports, showResolved, visible]);

  // ── Arming: the next map tap places the draft pin
  useEffect(() => {
    if (!L || !map || !arming) return;
    const el = map.getContainer();
    el.classList.add("kl-arming");
    const onClick = (e: Leaflet.LeafletMouseEvent) => {
      setArming(false);
      let name = "";
      try {
        name = localStorage.getItem(NAME_KEY) ?? "";
      } catch {
        /* ignore */
      }
      setDraft({
        lat: e.latlng.lat,
        lng: e.latlng.lng,
        kind: "ponding",
        title: "",
        note: "",
        depth_cm: "",
        observed_at: nowLocal(),
        reported_by: name,
        photoFile: null,
      });
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      el.classList.remove("kl-arming");
    };
  }, [L, map, arming]);

  // Draft pin, draggable so a mis-tap can be nudged.
  useEffect(() => {
    if (!L || !map) return;
    draftPinRef.current?.remove();
    draftPinRef.current = null;
    if (!draft) return;
    const icon = L.divIcon({ className: "kl-report-pin", html: pinSvg("#ffffff", false), iconSize: [26, 30], iconAnchor: [6, 29] });
    const m = L.marker([draft.lat, draft.lng], { icon, draggable: true, zIndexOffset: 1000 }).addTo(map);
    m.on("dragend", () => {
      const p = m.getLatLng();
      setDraft((d) => (d ? { ...d, lat: p.lat, lng: p.lng } : d));
    });
    draftPinRef.current = m;
    return () => {
      m.remove();
    };
    // Only re-create when a draft starts/ends; drags update state without re-creating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, map, draft !== null]);

  const save = async () => {
    if (!draft || !code) return;
    setBusy(true);
    setErr(null);
    try {
      let photo: string | null = null;
      if (draft.photoFile) {
        const blob = await shrinkPhoto(draft.photoFile);
        const fd = new FormData();
        fd.append("photo", blob, "photo.jpg");
        const pr = await fetch(PHOTO_API, { method: "POST", headers: headers(), body: fd });
        const pj = (await pr.json()) as { id?: string; error?: string };
        if (!pr.ok || !pj.id) throw new Error(pj.error ?? "อัปโหลดรูปไม่สำเร็จ");
        photo = pj.id;
      }
      const input: ReportInput = {
        lat: draft.lat,
        lng: draft.lng,
        kind: draft.kind,
        title: draft.title,
        note: draft.note,
        depth_cm: draft.depth_cm === "" ? null : Number(draft.depth_cm),
        observed_at: localToIso(draft.observed_at),
        reported_by: draft.reported_by,
        photo,
      };
      const r = await fetch(API, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(input) });
      const j = (await r.json()) as { report?: Report; reports?: Report[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      try {
        localStorage.setItem(NAME_KEY, draft.reported_by);
      } catch {
        /* ignore */
      }
      setReports(j.reports ?? []);
      setDraft(null);
      setSelected(j.report?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(API, { method: "PATCH", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ id, ...body }) });
      const j = (await r.json()) as { reports?: Report[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setReports(j.reports ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("ลบรายงานนี้ถาวร?")) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: headers() });
      const j = (await r.json()) as { reports?: Report[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setReports(j.reports ?? []);
      if (selected === id) setSelected(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(
    () => (reports ?? []).filter((r) => showResolved || r.status === "open"),
    [reports, showResolved],
  );
  const openCount = reports?.filter((r) => r.status === "open").length ?? 0;

  if (!active) return null;

  // ── Login
  if (!code) {
    return (
      <section className="kl-card">
        <div className="kl-card-head">
          <KeyRound size={16} style={{ color: "var(--accent)" }} />
          รายงานเจ้าหน้าที่
        </div>
        <p className="kl-muted" style={{ marginBottom: 10, lineHeight: 1.6 }}>
          ชั้นข้อมูลนี้บันทึกจุดที่เจ้าหน้าที่พบด้วยตนเอง — น้ำท่วมขังในซอย คลองล้น ท่ออุดตัน — ซึ่งดาวเทียมมองไม่เห็นในเขตบ้านหนาแน่น
          ใส่รหัสเจ้าหน้าที่เพื่อดูและเพิ่มจุด
        </p>
        <form onSubmit={login} style={{ display: "flex", gap: 8 }}>
          <input
            className="kl-input"
            type="password"
            placeholder="รหัสเจ้าหน้าที่"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            autoComplete="current-password"
          />
          <button className="kl-btn kl-btn-primary" type="submit" disabled={!codeInput.trim()}>
            เข้าใช้
          </button>
        </form>
        {err ? <div className="ms-err" style={{ marginTop: 8 }}>{err}</div> : null}
      </section>
    );
  }

  return (
    <>
      {err ? <div className="ms-err">{err}</div> : null}

      {/* ── Toolbar */}
      <section className="kl-card" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Flag size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {reports === null ? "กำลังโหลด…" : `${openCount} จุดที่ยังเปิดอยู่`}
        </span>
        <label className="kl-check" style={{ marginLeft: "auto" }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          แสดงที่แก้ไขแล้ว
        </label>
        <button className="kl-icon-btn" onClick={logout} title="ออกจากระบบ" aria-label="ออกจากระบบ">
          <LogOut size={14} />
        </button>
        {!draft ? (
          <button
            className={`kl-btn ${arming ? "" : "kl-btn-primary"}`}
            style={{ width: "100%" }}
            onClick={() => setArming((v) => !v)}
            disabled={!map}
          >
            {arming ? (
              <>
                <X size={14} /> ยกเลิก — แตะบนแผนที่เพื่อวางจุด
              </>
            ) : (
              <>
                <Crosshair size={14} /> เพิ่มจุดที่พบ
              </>
            )}
          </button>
        ) : null}
      </section>

      {/* ── New report form */}
      {draft ? (
        <section className="kl-card" style={{ borderColor: "rgba(64,224,189,0.45)" }}>
          <div className="kl-card-head">
            <MapPin size={16} style={{ color: "var(--accent)" }} />
            จุดใหม่
            <span className="kl-card-meta num-mono">
              {draft.lat.toFixed(5)}, {draft.lng.toFixed(5)} · ลากหมุดปรับได้
            </span>
          </div>
          <div className="kl-form">
            <label>
              ประเภท
              <div className="kl-kinds">
                {(Object.keys(REPORT_KINDS) as ReportKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`kl-kind ${draft.kind === k ? "on" : ""}`}
                    style={{ "--kc": REPORT_KINDS[k].color } as React.CSSProperties}
                    onClick={() => setDraft({ ...draft, kind: k })}
                  >
                    {REPORT_KINDS[k].label}
                  </button>
                ))}
              </div>
            </label>
            <label>
              ชื่อจุด / ซอย *
              <input className="kl-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="เช่น ซอยไร่ขิง 36 หน้าหมู่บ้าน…" maxLength={120} />
            </label>
            <div className="kl-form-row">
              <label>
                ระดับน้ำ (ซม.)
                <input className="kl-input" inputMode="numeric" value={draft.depth_cm} onChange={(e) => setDraft({ ...draft, depth_cm: e.target.value.replace(/[^\d]/g, "") })} placeholder="ถ้าวัดได้" />
              </label>
              <label>
                พบเมื่อ *
                <input className="kl-input" type="datetime-local" value={draft.observed_at} onChange={(e) => setDraft({ ...draft, observed_at: e.target.value })} />
              </label>
            </div>
            <label>
              รายละเอียด
              <textarea className="kl-input" rows={3} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="สาเหตุที่เห็น รถผ่านได้ไหม บ้านที่ได้รับผลกระทบ…" maxLength={1000} />
            </label>
            <div className="kl-form-row">
              <label>
                ผู้รายงาน *
                <input className="kl-input" value={draft.reported_by} onChange={(e) => setDraft({ ...draft, reported_by: e.target.value })} placeholder="ชื่อ-สกุล หรือฝ่าย" maxLength={80} />
              </label>
              <label>
                รูปถ่าย
                <span className="kl-file">
                  <Camera size={14} />
                  {draft.photoFile ? draft.photoFile.name.slice(0, 18) : "เลือกรูป"}
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => setDraft({ ...draft, photoFile: e.target.files?.[0] ?? null })} />
                </span>
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="kl-btn" type="button" onClick={() => setDraft(null)} disabled={busy}>
                ยกเลิก
              </button>
              <button className="kl-btn kl-btn-primary" type="button" onClick={() => void save()} disabled={busy || draft.title.trim().length < 2 || !draft.reported_by.trim()}>
                <Check size={14} /> {busy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── List */}
      {reports !== null && shown.length === 0 && !draft ? (
        <section className="kl-card kl-muted">ยังไม่มีจุดที่รายงาน — กด &ldquo;เพิ่มจุดที่พบ&rdquo; แล้วแตะบนแผนที่</section>
      ) : null}
      {shown.map((r) => {
        const isSel = selected === r.id;
        return (
          <section key={r.id} className={`kl-card kl-report ${isSel ? "is-selected" : ""} ${r.status === "resolved" ? "is-resolved" : ""}`}>
            <button
              className="kl-report-head"
              onClick={() => {
                setSelected(isSel ? null : r.id);
                map?.flyTo([r.lat, r.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
              }}
            >
              <span className="kl-report-swatch" style={{ background: REPORT_KINDS[r.kind].color }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.title}
                </span>
                <span className="kl-sub">
                  {REPORT_KINDS[r.kind].label}
                  {r.depth_cm !== null ? ` · ${r.depth_cm} ซม.` : ""} · {r.reported_by} · {fmt(r.observed_at)}
                </span>
              </span>
              {r.status === "resolved" ? <CheckCircle2 size={15} style={{ color: "var(--ink-3)", flex: "none" }} /> : null}
            </button>
            {isSel ? (
              <div className="kl-report-body">
                {r.note ? <p style={{ margin: "0 0 8px", fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{r.note}</p> : null}
                {r.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- streamed from the private store by id
                  <img src={`${PHOTO_API}?id=${r.photo}`} alt={r.title} className="kl-report-photo" loading="lazy" />
                ) : null}
                <div className="kl-sub" style={{ marginBottom: 8 }}>
                  บันทึก {fmt(r.created_at)}
                  {r.updated_at !== r.created_at ? ` · แก้ไข ${fmt(r.updated_at)}` : ""} · <span className="num-mono">{r.lat.toFixed(5)}, {r.lng.toFixed(5)}</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {r.status === "open" ? (
                    <button className="kl-btn" onClick={() => void patch(r.id, { status: "resolved" })} disabled={busy}>
                      <CheckCircle2 size={14} /> น้ำลดแล้ว / แก้ไขแล้ว
                    </button>
                  ) : (
                    <button className="kl-btn" onClick={() => void patch(r.id, { status: "open" })} disabled={busy}>
                      <Flag size={14} /> เปิดใหม่
                    </button>
                  )}
                  <button className="kl-btn kl-btn-danger" onClick={() => void remove(r.id)} disabled={busy}>
                    <Trash2 size={14} /> ลบ
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
