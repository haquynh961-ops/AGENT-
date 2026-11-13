const state = {
  base: null,
  opportunities: [],
  activeOpp: null,
  selectedSampleId: null,
  selectedStepNum: null,
  role: "minhan",
  custItems: [
    { sku: "LT-TP-T14G5", quantity: 10 },
    { sku: "FW-FG-100F", quantity: 1 }
  ],
  chatMessages: [],
  searchQuery: "",
  geminiApiKey: localStorage.getItem("minhan_gemini_key") || ""
};

const DEFAULT_FLOW_STEPS = [
  { step: 1, code: "RECEIVE", actor: "AI", title: "Tiếp nhận yêu cầu", status: "pending", detail: "Email / Form" },
  { step: 2, code: "TRIAGE", actor: "Con người & AI", title: "Phân loại & Kiểm tra", status: "pending", detail: "Đủ 4/4 nhóm thông tin?" },
  { step: 3, code: "CLARIFY", actor: "NVKD & AI", title: "Yêu cầu KH làm rõ", status: "pending", detail: "Rẽ nhánh nếu thiếu" },
  { step: 4, code: "ASSIGN", actor: "AI", title: "Tạo Hồ sơ & Gán phụ trách", status: "pending", detail: "Mã OPP + 1/6 NVKD" },
  { step: 5, code: "OPS_CHECK", actor: "AI", title: "Thẩm định tồn kho & giá", status: "pending", detail: "Khả thi hay Lỗi?" },
  { step: 6, code: "PROPOSAL", actor: "AI", title: "Lập Báo giá & Đề xuất", status: "pending", detail: "Kiểm tra CK <= 5%?" },
  { step: 7, code: "APPROVAL", actor: "Trưởng phòng", title: "Trưởng phòng duyệt?", status: "pending", detail: "Duyệt hay Từ chối?" },
  { step: 8, code: "TRACK", actor: "Con người & AI", title: "Cập nhật & Theo dõi", status: "pending", detail: "Gửi báo giá & chốt" }
];

function fmtVnd(n) {
  if (n === null || n === undefined) return "Chưa có";
  return Number(n).toLocaleString("vi-VN") + " đ";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showToast(msg) {
  const el = document.getElementById("toastBox");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function statusBadgeHtml(status, label) {
  if (status === "READY_TO_SEND" || status === "APPROVED_READY_TO_SEND" || status === "CUSTOMER_CONFIRMED") {
    return `<span class="pill-badge badge-mint">${escapeHtml(label)}</span>`;
  }
  if (status === "WAITING_CLARIFICATION") {
    return `<span class="pill-badge badge-amber">${escapeHtml(label)}</span>`;
  }
  if (status === "PENDING_MANAGER_APPROVAL") {
    return `<span class="pill-badge badge-sky">${escapeHtml(label)}</span>`;
  }
  if (status === "NOT_FEASIBLE" || status === "REVISION_REQUIRED") {
    return `<span class="pill-badge badge-red">${escapeHtml(label)}</span>`;
  }
  return `<span class="pill-badge badge-pink">${escapeHtml(label)}</span>`;
}

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function extractWithGeminiIfConfigured(rawContent, catalog) {
  if (!state.geminiApiKey) return null;
  const catalogHint = catalog.map(c => `${c.sku}: ${c.name}`).join("\n");
  const prompt = `Bạn là Intake & Triage AI Agent của Công ty Minh An.
Trích xuất thông tin từ yêu cầu B2B sau thành JSON thuần (không markdown).
Danh mục SKU chuẩn:
${catalogHint}

Yêu cầu khách hàng:
"""
${rawContent}
"""

Trả về JSON đúng schema:
{
  "items": [{"sku": "string hoặc null", "raw_name": "string", "quantity": number}],
  "budget_vnd": number hoặc null,
  "requested_deadline_days": number hoặc null,
  "requested_deadline_text": "string hoặc null",
  "requested_discount_pct": number,
  "approver_identified": boolean,
  "approver_name": "string hoặc null",
  "mentions_old_price": boolean
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(state.geminiApiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
    })
  });
  if (!resp.ok) {
    throw new Error("Gemini API lỗi (" + resp.status + "), kiểm tra lại API Key.");
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

function renderHeroKpis() {
  const opps = state.opportunities || [];
  const waiting = opps.filter(o => o.status === "WAITING_CLARIFICATION").length;
  const mgrPending = opps.filter(o => o.status === "PENDING_MANAGER_APPROVAL").length;
  const ready = opps.filter(o => o.status === "READY_TO_SEND" || o.status === "APPROVED_READY_TO_SEND").length;

  document.getElementById("kpiTotalValue").textContent = opps.length > 0 ? `+${opps.length}` : "180";
  document.getElementById("kpiTotalSub").textContent = opps.length > 0 ? "hồ sơ đã xử lý phiên này" : "yêu cầu/tuần (6 NVKD)";

  document.getElementById("kpiPendingValue").textContent = `+${waiting + mgrPending}`;
  document.getElementById("kpiPendingPill").textContent = `${waiting} chờ KH • ${mgrPending} chờ duyệt`;

  document.getElementById("kpiReadyValue").textContent = `+${ready}`;

  // Card 1: 3-layer textured bars (Dark base + Hatch + Dots)
  const heights1 = [
    [24, 24, 24],
    [18, 22, 18],
    [14, 18, 16],
    [22, 22, 20],
    [28, 26, 22]
  ];
  document.getElementById("barsCard1").innerHTML = heights1.map(([b, m, t]) => `
    <div class="bar-col">
      <div class="seg-dots-lavender" style="height:${t}px"></div>
      <div class="seg-hatch-lavender" style="height:${m}px"></div>
      <div class="seg-dark" style="height:${b}px"></div>
    </div>
  `).join("");

  // Card 2: Smooth dark vertical gradient bars
  const heights2 = [28, 52, 42, 72, 58];
  document.getElementById("barsCard2").innerHTML = heights2.map(h => `
    <div class="bar-col">
      <div class="seg-grad" style="height:${h}px"></div>
    </div>
  `).join("");

  // Card 3: 2-layer bars (Dark base + Hatch upper)
  const heights3 = [
    [24, 34],
    [18, 20],
    [20, 24],
    [24, 42],
    [26, 50]
  ];
  document.getElementById("barsCard3").innerHTML = heights3.map(([b, t]) => `
    <div class="bar-col">
      <div class="seg-hatch-pink" style="height:${t}px"></div>
      <div class="seg-dark" style="height:${b}px"></div>
    </div>
  `).join("");
}

function renderPipelineMatrix() {
  const opps = state.opportunities || [];
  const emailOpps = opps.filter(o => o.channel === "Email");
  const formOpps = opps.filter(o => o.channel === "Web Form");

  const rows = [
    {
      label: "Kênh Email",
      cls: "pm-lavender",
      vals: [
        emailOpps.length || 108,
        emailOpps.filter(o => o.is_complete).length || 84,
        emailOpps.filter(o => o.requires_manager_approval).length || 22,
        emailOpps.filter(o => o.status === "READY_TO_SEND" || o.status === "APPROVED_READY_TO_SEND").length || 62
      ]
    },
    {
      label: "Kênh Web Form",
      cls: "pm-sky",
      vals: [
        formOpps.length || 72,
        formOpps.filter(o => o.is_complete).length || 56,
        formOpps.filter(o => o.requires_manager_approval).length || 14,
        formOpps.filter(o => o.status === "READY_TO_SEND" || o.status === "APPROVED_READY_TO_SEND").length || 42
      ]
    },
    {
      label: "Cần làm rõ / Vượt quyền",
      cls: "pm-pink",
      vals: [
        opps.filter(o => !o.is_complete).length || 40,
        opps.filter(o => o.status === "WAITING_CLARIFICATION").length || 18,
        opps.filter(o => o.status === "PENDING_MANAGER_APPROVAL").length || 12,
        null
      ]
    },
    {
      label: "Đạt chuẩn BG-2026-11",
      cls: "pm-mint",
      vals: [
        null,
        opps.filter(o => o.is_complete && o.deadline_feasible).length || 120,
        opps.filter(o => o.quoted_count > 0 && o.quoted_count === o.extracted_count).length || 118,
        opps.filter(o => o.status === "READY_TO_SEND" || o.status === "APPROVED_READY_TO_SEND").length || 104
      ]
    }
  ];

  const headers = ["Luồng xử lý", "Tiếp nhận", "Đủ thông tin & Giá", "Trưởng phòng duyệt", "Sẵn sàng chốt"];
  const headHtml = headers.map(h => `<div class="pm-head">${escapeHtml(h)}</div>`).join("");
  const bodyHtml = rows.map(r => `
    <div class="pm-row-label">${escapeHtml(r.label)}</div>
    ${r.vals.map(v => v === null
      ? `<div class="pm-cell pm-empty">–</div>`
      : `<div class="pm-cell ${r.cls}">${v}</div>`
    ).join("")}
  `).join("");

  document.getElementById("pipelineMatrix").innerHTML = headHtml + bodyHtml;
}

function renderFlowchart(steps) {
  const container = document.getElementById("flowchartStrip");
  const list = steps && steps.length ? steps : DEFAULT_FLOW_STEPS;
  container.innerHTML = list.map(s => {
    const actor = s.actor || "AI";
    const isAi = actor === "AI";
    const isSelected = state.selectedStepNum === s.step;
    return `
      <div class="flow-node clickable ${escapeHtml(s.status)} ${isSelected ? "selected-step" : ""}" onclick="selectFlowStep(${s.step})" title="Bấm để tương tác với Bước ${s.step}">
        <div class="flow-top-row">
          <span class="step-num">Bước ${s.step}</span>
          <span class="actor-tag ${isAi ? "is-ai" : ""}">${escapeHtml(actor)}</span>
        </div>
        <div class="step-title">${escapeHtml(s.title)}</div>
        <div class="step-detail">${escapeHtml(s.detail)}</div>
      </div>
    `;
  }).join("");
  renderStepInspector(list);
}

function renderStepInspector(list) {
  const box = document.getElementById("stepInspector");
  if (!state.selectedStepNum) {
    box.classList.add("hidden");
    return;
  }
  const s = list.find(x => x.step === state.selectedStepNum);
  if (!s) {
    box.classList.add("hidden");
    return;
  }
  const opp = state.activeOpp;
  let actionBtn = `<button type="button" class="btn btn-soft btn-sm" onclick="askAiAboutStep(${s.step})">🤖 Hỏi AI về Bước ${s.step}</button>`;
  if (opp) {
    if (s.step === 3 && opp.status === "WAITING_CLARIFICATION") {
      actionBtn = `<button type="button" class="btn btn-dark btn-sm" onclick="openClarifyModal('${escapeHtml(opp.id)}')">💬 Bổ sung thông tin Bước 3</button>` + actionBtn;
    } else if (s.step === 5 && opp.status === "NOT_FEASIBLE") {
      actionBtn = `<button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(opp.id)}', 'negotiate')">🤝 Thương thảo phương án Bước 5</button>` + actionBtn;
    } else if (s.step === 7 && opp.status === "PENDING_MANAGER_APPROVAL") {
      actionBtn = `<button type="button" class="btn btn-dark btn-sm" onclick="switchTab('approvals')">👔 Mở Cổng Trưởng phòng duyệt</button>` + actionBtn;
    } else if (s.step === 7 && opp.status === "REVISION_REQUIRED") {
      actionBtn = `<button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(opp.id)}', 'revise')">✏️ Chỉnh sửa & Trình lại</button>` + actionBtn;
    }
  } else if (s.step === 1) {
    actionBtn = `<button type="button" class="btn btn-dark btn-sm" onclick="document.getElementById('inpRawContent').focus()">📝 Nhập yêu cầu Bước 1</button>` + actionBtn;
  }

  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="step-inspector-info">
      <strong>Bước ${s.step}: ${escapeHtml(s.title)} (${escapeHtml(s.actor || "AI")})</strong>
      <p>${escapeHtml(s.detail)} ${opp ? `• Hồ sơ đang xem: <strong>${escapeHtml(opp.id)}</strong>` : "• Chưa chọn hồ sơ, bạn có thể bấm nút bên phải để hỏi AI hoặc chạy mẫu."}</p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${actionBtn}
      <button type="button" class="btn btn-soft btn-sm" onclick="selectFlowStep(null)">✕</button>
    </div>
  `;
}

window.selectFlowStep = function (stepNum) {
  state.selectedStepNum = state.selectedStepNum === stepNum ? null : stepNum;
  renderFlowchart(state.activeOpp?.steps_trail);
};

window.askAiAboutStep = function (stepNum) {
  openAiChat();
  const s = (state.activeOpp?.steps_trail || DEFAULT_FLOW_STEPS).find(x => x.step === stepNum);
  const q = state.activeOpp
    ? `Giải thích trạng thái Bước ${stepNum} (${s?.title}) của hồ sơ ${state.activeOpp.id}`
    : `Bước ${stepNum} (${s?.title}) trong quy trình Minh An hoạt động như thế nào?`;
  document.getElementById("aiChatInput").value = q;
  sendAiChatMessage(q);
};

function renderSummary4Grid() {
  const opps = state.opportunities || [];
  const canContinue = opps.filter(o => o.status === "READY_TO_SEND" || o.status === "APPROVED_READY_TO_SEND").length;
  const needClarify = opps.filter(o => o.status === "WAITING_CLARIFICATION").length;
  const notFeasible = opps.filter(o => o.status === "NOT_FEASIBLE").length;
  const pendingApproval = opps.filter(o => o.status === "PENDING_MANAGER_APPROVAL" || o.status === "REVISION_REQUIRED").length;

  document.getElementById("summary4Grid").innerHTML = `
    <div class="summary-box badge-mint"><span>Có thể tiếp tục (Bước 8)</span><strong>${canContinue}</strong></div>
    <div class="summary-box badge-amber"><span>Cần bổ sung (Bước 3)</span><strong>${needClarify}</strong></div>
    <div class="summary-box badge-red"><span>Chưa đáp ứng (Bước 5)</span><strong>${notFeasible}</strong></div>
    <div class="summary-box badge-sky"><span>Chờ duyệt / Sửa (Bước 7)</span><strong>${pendingApproval}</strong></div>
  `;
}

function renderSamples() {
  const wrap = document.getElementById("sampleButtons");
  const samples = state.base?.sample_requests || [];
  const shortLabels = {
    "REQ-2026-101": "Mẫu 1: Đủ tin, CK 8% (Trưởng phòng duyệt)",
    "REQ-2026-102": "Mẫu 2: Thiếu ngân sách & người duyệt",
    "REQ-2026-103": "Mẫu 3: Đòi giá cũ & thiếu tồn/gấp hạn",
    "REQ-2026-104": "Mẫu 4: Đạt chuẩn (Chốt thẳng)"
  };

  wrap.innerHTML = samples.map(s => `
    <button type="button" class="sample-btn ${state.selectedSampleId === s.id ? "selected" : ""}" data-id="${escapeHtml(s.id)}">
      ${escapeHtml(shortLabels[s.id] || s.id)}
    </button>
  `).join("");

  wrap.querySelectorAll(".sample-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const sample = samples.find(x => x.id === btn.dataset.id);
      if (!sample) return;
      state.selectedSampleId = sample.id;
      document.getElementById("inpChannel").value = sample.channel;
      document.getElementById("inpCompany").value = sample.customer_company;
      document.getElementById("inpContactName").value = sample.contact_name;
      document.getElementById("inpContactEmail").value = sample.contact_email;
      document.getElementById("inpRawContent").value = sample.raw_content;
      renderSamples();
    });
  });
}

function renderResult(opp) {
  const emptyEl = document.getElementById("resultEmpty");
  const bodyEl = document.getElementById("resultBody");
  const badgeEl = document.getElementById("resultStatusBadge");

  if (!opp) {
    emptyEl.classList.remove("hidden");
    bodyEl.classList.add("hidden");
    badgeEl.className = "pill-badge";
    badgeEl.textContent = "Chưa chạy";
    renderFlowchart(null);
    return;
  }

  emptyEl.classList.add("hidden");
  bodyEl.classList.remove("hidden");
  badgeEl.outerHTML = `<span id="resultStatusBadge">${statusBadgeHtml(opp.status, opp.status_label)}</span>`;
  document.getElementById("currentOppLabel").textContent = `Đang xem hồ sơ ${opp.id} • Phụ trách: ${opp.owner_name} (${opp.owner_id})`;

  renderFlowchart(opp.steps_trail);

  document.getElementById("resultMetaGrid").innerHTML = `
    <div class="meta-box"><div class="k">Mã Hồ sơ</div><div class="v">${escapeHtml(opp.id)}</div></div>
    <div class="meta-box"><div class="k">NVKD Phụ trách</div><div class="v">${escapeHtml(opp.owner_name)}</div></div>
    <div class="meta-box"><div class="k">Đối soát hạng mục</div><div class="v">${opp.quoted_count}/${opp.extracted_count} (0% bỏ sót)</div></div>
    <div class="meta-box"><div class="k">SLA Theo dõi</div><div class="v">${opp.sla_hours} giờ</div></div>
  `;

  const warnings = [...(opp.warnings || [])];
  if (opp.escalation_reasons?.length) {
    warnings.push("Lý do chuyển Trưởng phòng: " + opp.escalation_reasons.join(" | "));
  }
  document.getElementById("resultWarnings").innerHTML = warnings.map(w => `
    <div class="alert ${opp.deadline_feasible === false || opp.mentions_old_price ? "alert-danger" : "alert-warn"}">
      ⚠️ ${escapeHtml(w)}
    </div>
  `).join("");

  const gateChecks = [
    { label: "Sản phẩm & Số lượng", ok: opp.extracted_count > 0, val: `${opp.extracted_count} hạng mục` },
    { label: "Ngân sách tổng", ok: !!opp.budget_vnd, val: opp.budget_vnd ? fmtVnd(opp.budget_vnd) : "Thiếu" },
    { label: "Thời hạn triển khai", ok: !!opp.requested_deadline_days, val: opp.requested_deadline_text || "Thiếu" },
    { label: "Người phê duyệt", ok: !!opp.approver_identified, val: opp.approver_name || "Chưa rõ" }
  ];

  document.getElementById("resultGateSection").innerHTML = `
    <div class="section-title">Kiểm tra Đủ thông tin (Completeness Gate)</div>
    <div class="meta-grid">
      ${gateChecks.map(g => `
        <div class="meta-box">
          <div class="k">${g.ok ? "✅" : "❌"} ${escapeHtml(g.label)}</div>
          <div class="v">${escapeHtml(g.val)}</div>
        </div>
      `).join("")}
    </div>
  `;

  if (!opp.is_complete) {
    document.getElementById("resultPricingSection").innerHTML = "";
    document.getElementById("resultOutputSection").innerHTML = `
      <div class="section-title">Email Yêu cầu Khách hàng Làm rõ / Bổ sung</div>
      <div class="code-block">${escapeHtml(opp.clarification_email)}</div>
      <div class="opp-actions">
        <button type="button" class="btn btn-dark btn-sm" onclick="openClarifyModal('${escapeHtml(opp.id)}')">
          💬 Giả lập KH phản hồi bổ sung & Chạy lại
        </button>
      </div>
    `;
    return;
  }

  document.getElementById("resultPricingSection").innerHTML = `
    <div class="section-title">Thẩm định Giá (${escapeHtml(state.base.company.active_price_list_version)}) & Tồn kho Vận hành</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Sản phẩm / Dịch vụ</th>
            <th>SL</th>
            <th>Đơn giá mới</th>
            <th>Thành tiền</th>
            <th>Tồn kho & Tiến độ</th>
          </tr>
        </thead>
        <tbody>
          ${opp.line_items.map(li => `
            <tr>
              <td>${li.line_no}</td>
              <td><strong>${escapeHtml(li.name)}</strong><br><span class="muted">${escapeHtml(li.sku)}</span></td>
              <td>${li.quantity} ${escapeHtml(li.unit)}</td>
              <td>${fmtVnd(li.unit_price_vnd)}</td>
              <td><strong>${fmtVnd(li.line_total_vnd)}</strong></td>
              <td>
                <span class="pill-badge ${li.shortfall > 0 ? "badge-red" : "badge-mint"}">${escapeHtml(li.stock_status)}</span>
                <div class="muted">Khả thi: ${li.item_feasible_days} ngày</div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  if (opp.status === "NOT_FEASIBLE") {
    document.getElementById("resultOutputSection").innerHTML = `
      <div class="section-title">Nhánh Lỗi Bước 5 — Hướng dẫn NVKD Thương thảo Phương án Thay thế</div>
      <div class="code-block">${escapeHtml(opp.negotiation_script)}</div>
      <div class="opp-actions">
        <button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(opp.id)}', 'negotiate')">
          🤝 NVKD thương thảo xong với KH -> Chạy tiếp Bước 6
        </button>
      </div>
    `;
    return;
  }

  let actionArea = "";
  if (opp.status === "PENDING_MANAGER_APPROVAL") {
    actionArea = `
      <div class="opp-actions">
        <button type="button" class="btn btn-dark btn-sm" onclick="switchTab('approvals')">
          👔 Mở Cổng Trưởng phòng duyệt (Bước 7)
        </button>
      </div>
    `;
  } else if (opp.status === "REVISION_REQUIRED") {
    actionArea = `
      <div class="opp-actions">
        <button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(opp.id)}', 'revise')">
          ✏️ Con người kiểm tra & chỉnh sửa lại đề xuất -> Trình lại
        </button>
      </div>
    `;
  }

  document.getElementById("resultOutputSection").innerHTML = `
    <div class="section-title">Dự thảo Báo giá & Đề xuất</div>
    <div class="code-block">${escapeHtml(opp.proposal_draft)}</div>
    ${actionArea}
  `;
}

function renderRightRail() {
  const base = state.base;
  if (!base) return;
  const opps = state.opportunities || [];

  const insights = [
    { icon: "✉", name: "Yêu cầu từ Email", val: `${opps.filter(o => o.channel === "Email").length} phiên này` },
    { icon: "📋", name: "Từ Web Form", val: `${opps.filter(o => o.channel === "Web Form").length} phiên này` },
    { icon: "🏷", name: "Khóa bảng giá", val: base.company.active_price_list_version },
    { icon: "🛡", name: "Hạn mức CK NVKD", val: `≤ ${base.authority_policy.sales_rep_max_discount_pct}%` },
    { icon: "⏱", name: "SLA Chống trôi", val: `${base.authority_policy.sla_clarification_followup_hours} giờ` }
  ];

  document.getElementById("guardrailInsights").innerHTML = insights.map(i => `
    <div class="insight-row">
      <div class="insight-left">
        <div class="insight-icon-box">${i.icon}</div>
        <div class="insight-name">${escapeHtml(i.name)}</div>
      </div>
      <div class="insight-val">${escapeHtml(i.val)}</div>
    </div>
  `).join("");

  const avatarColors = ["var(--lavender)", "var(--sky)", "var(--pink)", "var(--mint)", "#fde68a", "#e2e8f0"];
  document.getElementById("railPeopleList").innerHTML = base.sales_team.map((r, idx) => {
    const initials = r.name.split(" ").slice(-2).map(w => w[0]).join("").toUpperCase();
    const sessionCount = opps.filter(o => o.owner_id === r.id).length;
    const tagText = sessionCount > 0 ? `+${sessionCount} mới` : `${r.active_deals} hồ sơ`;
    return `
      <div class="person-row">
        <div class="person-left">
          <div class="avatar-circle" style="background:${avatarColors[idx % avatarColors.length]}">${escapeHtml(initials)}</div>
          <div class="person-meta">
            <div class="person-name">${escapeHtml(r.name)}</div>
            <div class="person-sub">${escapeHtml(r.specialty)}</div>
          </div>
        </div>
        <span class="dark-tag">${escapeHtml(tagText)}</span>
      </div>
    `;
  }).join("");
}

function matchesSearch(opp) {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [opp.id, opp.customer_company, opp.owner_name, opp.raw_content, opp.status_label]
    .some(v => String(v || "").toLowerCase().includes(q));
}

function renderTracker() {
  const allOpps = state.opportunities || [];
  const opps = allOpps.filter(matchesSearch);
  const team = state.base?.sales_team || [];
  document.getElementById("countTracker").textContent = allOpps.length;

  const trackerDot = document.getElementById("railTrackerDot");
  trackerDot.classList.toggle("hidden", allOpps.length === 0);

  const extraLoad = {};
  team.forEach(r => (extraLoad[r.id] = 0));
  allOpps.forEach(o => {
    if (extraLoad[o.owner_id] !== undefined) extraLoad[o.owner_id]++;
  });

  document.getElementById("workloadGrid").innerHTML = team.map(r => `
    <div class="rep-card">
      <strong>${escapeHtml(r.name)}</strong> (${escapeHtml(r.id)})
      <div class="muted">${escapeHtml(r.specialty)}</div>
      <div style="margin-top:6px;font-size:12px;">
        Hồ sơ nền: <strong>${r.active_deals}</strong> • Phiên này: <strong>+${extraLoad[r.id]}</strong>
      </div>
    </div>
  `).join("");

  const listEl = document.getElementById("trackerList");
  if (!opps.length) {
    listEl.innerHTML = `<div class="empty-box">Chưa có hồ sơ phù hợp. Hãy chạy thử một kịch bản ở tab Quy trình AI.</div>`;
    return;
  }

  listEl.innerHTML = opps.map(o => `
    <div class="opp-card">
      <div class="opp-top">
        <div>
          <strong>${escapeHtml(o.id)}</strong> — ${escapeHtml(o.customer_company)}
          <div class="muted">Kênh: ${escapeHtml(o.channel)} • Phụ trách: <strong>${escapeHtml(o.owner_name)}</strong> • SLA: ${o.sla_hours}h</div>
        </div>
        ${statusBadgeHtml(o.status, o.status_label)}
      </div>
      <div style="margin-top:8px;font-size:13px;">
        ${o.is_complete
          ? `Hạng mục: <strong>${o.quoted_count}/${o.extracted_count}</strong> • Tổng sau CK (${o.requested_discount_pct}%): <strong>${fmtVnd(o.final_total_vnd)}</strong> • Khả thi: <strong>${o.max_feasible_days} ngày</strong> (KH cần ${o.requested_deadline_days} ngày)`
          : `Đang thiếu: <strong>${escapeHtml((o.missing_fields || []).join(", "))}</strong>`}
      </div>
      <div class="opp-actions">
        <button type="button" class="btn btn-soft btn-sm" onclick="inspectOpp('${escapeHtml(o.id)}')">🔍 Xem trên Quy trình</button>
        ${o.status === "WAITING_CLARIFICATION"
          ? `<button type="button" class="btn btn-dark btn-sm" onclick="openClarifyModal('${escapeHtml(o.id)}')">💬 Giả lập KH bổ sung (Bước 3)</button>`
          : ""}
        ${o.status === "NOT_FEASIBLE"
          ? `<button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(o.id)}', 'negotiate')">🤝 Thương thảo phương án (Bước 5)</button>`
          : ""}
        ${o.status === "REVISION_REQUIRED"
          ? `<button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(o.id)}', 'revise')">✏️ Chỉnh sửa & trình lại (Bước 7)</button>`
          : ""}
      </div>
    </div>
  `).join("");
}

function renderApprovals() {
  const opps = (state.opportunities || [])
    .filter(o => o.requires_manager_approval || o.status === "PENDING_MANAGER_APPROVAL" || o.manager_decision)
    .filter(matchesSearch);
  const pendingCount = (state.opportunities || []).filter(o => o.status === "PENDING_MANAGER_APPROVAL").length;

  document.getElementById("countApprovals").textContent = pendingCount;
  const railBadge = document.getElementById("railApprovalBadge");
  railBadge.textContent = pendingCount;
  railBadge.classList.toggle("hidden", pendingCount === 0);

  const listEl = document.getElementById("approvalList");
  if (!opps.length) {
    listEl.innerHTML = `<div class="empty-box">Chưa có trường hợp vượt thẩm quyền nào cần Trưởng phòng Kinh doanh phê duyệt.</div>`;
    return;
  }

  listEl.innerHTML = opps.map(o => `
    <div class="opp-card">
      <div class="opp-top">
        <div>
          <strong>${escapeHtml(o.id)}</strong> — ${escapeHtml(o.customer_company)}
          <div class="muted">NVKD: <strong>${escapeHtml(o.owner_name)}</strong> • Tổng đơn: <strong>${fmtVnd(o.final_total_vnd)}</strong> • Chiết khấu: <strong>${o.requested_discount_pct}%</strong></div>
        </div>
        ${statusBadgeHtml(o.status, o.status_label)}
      </div>
      <div class="alert alert-warn" style="margin-top:10px;">
        <strong>Lý do vượt thẩm quyền:</strong> ${escapeHtml((o.escalation_reasons || []).join(" | "))}
      </div>
      ${o.manager_decision
        ? `<div class="alert ${o.manager_decision.decision === "APPROVE" ? "alert-ok" : "alert-danger"}">
             Quyết định của ${escapeHtml(o.manager_decision.manager_name)}: <strong>${escapeHtml(o.manager_decision.decision)}</strong> — ${escapeHtml(o.manager_decision.note || "")}
           </div>
           ${o.status === "REVISION_REQUIRED"
             ? `<div class="opp-actions">
                  <button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(o.id)}', 'revise')">✏️ Con người kiểm tra & chỉnh sửa -> Trình lại</button>
                </div>`
             : ""}`
        : `<div class="opp-actions">
             <button type="button" class="btn btn-dark btn-sm" onclick="submitManagerDecision('${escapeHtml(o.id)}', 'APPROVE')">✅ Duyệt -> Bước 8</button>
             <button type="button" class="btn btn-danger btn-sm" onclick="submitManagerDecision('${escapeHtml(o.id)}', 'REJECT')">✕ Từ chối / Cần sửa</button>
           </div>`}
    </div>
  `).join("");
}

function renderMasterData() {
  const q = state.searchQuery.trim().toLowerCase();
  const catalog = (state.base?.catalog || []).filter(c =>
    !q || c.sku.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
  const team = state.base?.sales_team || [];
  const policy = state.base?.authority_policy || {};

  document.querySelector("#catalogTable tbody").innerHTML = catalog.map(c => `
    <tr>
      <td><strong>${escapeHtml(c.sku)}</strong></td>
      <td>${escapeHtml(c.name)}</td>
      <td><strong>${fmtVnd(c.current_price_vnd)}</strong></td>
      <td class="muted" style="text-decoration:line-through;">${fmtVnd(c.old_price_vnd)}</td>
      <td>${c.stock_available} ${escapeHtml(c.unit)}</td>
      <td>${c.inbound_qty > 0 ? `+${c.inbound_qty} sau ${c.inbound_eta_days} ngày` : "Dịch vụ sẵn sàng"} • Triển khai: ${c.deploy_lead_time_days} ngày</td>
    </tr>
  `).join("");

  document.querySelector("#salesTeamTable tbody").innerHTML = team.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.id)}</strong></td>
      <td>${escapeHtml(r.name)}<br><span class="muted">${escapeHtml(r.email)}</span></td>
      <td>${escapeHtml(r.specialty)}</td>
      <td>${r.active_deals}</td>
    </tr>
  `).join("");

  document.getElementById("policyBox").innerHTML = `
    <strong>Chính sách & Guardrails tự động:</strong>
    <ul>
      <li>Chiết khấu tối đa NVKD tự duyệt: <strong>${policy.sales_rep_max_discount_pct}%</strong> (vượt mức -> Trưởng phòng duyệt).</li>
      <li>Ngưỡng đơn hàng lớn cần Trưởng phòng duyệt: <strong>${fmtVnd(policy.auto_escalate_if_total_over_vnd)}</strong>.</li>
      <li>SLA nhắc khách hàng bổ sung thông tin: <strong>${policy.sla_clarification_followup_hours} giờ</strong>.</li>
      <li>Bảng giá hiện hành khóa cứng: <strong>${escapeHtml(state.base?.company?.active_price_list_version)}</strong>.</li>
    </ul>
  `;
}

function renderCustomerPortal() {
  const catalog = state.base?.catalog || [];
  const select = document.getElementById("custCatalogSelect");
  if (select && select.options.length !== catalog.length) {
    select.innerHTML = catalog.map(c =>
      `<option value="${escapeHtml(c.sku)}">${escapeHtml(c.name)} (${fmtVnd(c.current_price_vnd)})</option>`
    ).join("");
  }

  const catalogMap = {};
  catalog.forEach(c => { catalogMap[c.sku] = c; });
  document.getElementById("custSelectedChips").innerHTML = state.custItems.map((it, idx) => {
    const cat = catalogMap[it.sku];
    return `
      <span class="item-chip">
        <span>${it.quantity} × ${escapeHtml(cat ? cat.name : it.sku)}</span>
        <button type="button" onclick="removeCustItem(${idx})" title="Xóa">×</button>
      </span>
    `;
  }).join("");

  const opps = (state.opportunities || []).filter(matchesSearch);
  const needAction = opps.filter(o => o.status === "WAITING_CLARIFICATION" || o.status === "NOT_FEASIBLE").length;
  const readyCount = opps.filter(o => ["READY_TO_SEND", "APPROVED_READY_TO_SEND", "CUSTOMER_CONFIRMED"].includes(o.status)).length;
  document.getElementById("custKpiTotal").textContent = opps.length;
  document.getElementById("custKpiAction").textContent = needAction;
  document.getElementById("custKpiReady").textContent = readyCount;

  const listEl = document.getElementById("customerOppList");
  if (!opps.length) {
    listEl.innerHTML = `<div class="empty-box">Quý khách chưa gửi yêu cầu nào trong phiên này. Hãy chọn sản phẩm bên trái hoặc chat với Trợ lý AI góc phải để tạo yêu cầu!</div>`;
    return;
  }

  listEl.innerHTML = opps.map(o => {
    let customerBox = "";
    let actionBtns = "";
    if (o.status === "WAITING_CLARIFICATION") {
      customerBox = `<div class="alert alert-warn" style="margin-top:8px;"><strong>Minh An cần Anh/Chị bổ sung:</strong> ${escapeHtml((o.missing_fields || []).join(", "))}</div>`;
      actionBtns = `<button type="button" class="btn btn-dark btn-sm" onclick="openClarifyModal('${escapeHtml(o.id)}')">💬 Bổ sung thông tin ngay</button>`;
    } else if (o.status === "NOT_FEASIBLE") {
      customerBox = `<div class="alert alert-danger" style="margin-top:8px;"><strong>Thông báo tiến độ:</strong> Kho cần ${o.max_feasible_days} ngày để giao trọn bộ (yêu cầu của Quý khách: ${o.requested_deadline_days} ngày). NVKD ${escapeHtml(o.owner_name)} đề xuất giao 2 đợt hoặc lùi ngày.</div>`;
      actionBtns = `<button type="button" class="btn btn-dark btn-sm" onclick="openNegotiateModal('${escapeHtml(o.id)}', 'negotiate')">🤝 Chọn phương án giao hàng mới</button>`;
    } else if (o.status === "PENDING_MANAGER_APPROVAL") {
      customerBox = `<div class="alert alert-warn" style="margin-top:8px;">Đề xuất ưu đãi (${o.requested_discount_pct}%) đang được Trưởng phòng Kinh doanh Minh An xem xét phê duyệt.</div>`;
    } else if (o.status === "READY_TO_SEND" || o.status === "APPROVED_READY_TO_SEND") {
      customerBox = `<div class="alert alert-ok" style="margin-top:8px;">Báo giá chính thức đã sẵn sàng: <strong>${fmtVnd(o.final_total_vnd)}</strong> (Giao trong ${o.max_feasible_days} ngày).</div>`;
      actionBtns = `<button type="button" class="btn btn-dark btn-sm" onclick="confirmCustomerOrder('${escapeHtml(o.id)}')">✅ Xác nhận Đặt hàng / Chốt Báo giá</button>`;
    } else if (o.status === "CUSTOMER_CONFIRMED") {
      customerBox = `<div class="alert alert-ok" style="margin-top:8px;">Quý khách đã xác nhận đặt hàng! Nhân viên ${escapeHtml(o.owner_name)} đang tiến hành triển khai.</div>`;
    }

    return `
      <div class="opp-card">
        <div class="opp-top">
          <div>
            <strong>${escapeHtml(o.id)}</strong> — ${escapeHtml(o.customer_company)}
            <div class="muted">NVKD Minh An hỗ trợ: <strong>${escapeHtml(o.owner_name)}</strong> (${escapeHtml(o.owner_email)})</div>
          </div>
          ${statusBadgeHtml(o.status, o.status_label)}
        </div>
        ${customerBox}
        <div class="opp-actions">
          ${actionBtns}
          <button type="button" class="btn btn-soft btn-sm" onclick="askAiAboutOpp('${escapeHtml(o.id)}')">🤖 Hỏi AI về hồ sơ này</button>
        </div>
      </div>
    `;
  }).join("");
}

window.removeCustItem = function (idx) {
  state.custItems.splice(idx, 1);
  renderCustomerPortal();
};

window.confirmCustomerOrder = async function (oppId) {
  const res = await apiPost("/api/customer-confirm", { opportunity_id: oppId });
  await loadState(res.opportunity.id);
  showToast(`Đã xác nhận chốt đơn ${oppId}!`);
};

function switchAccount(role) {
  state.role = role === "customer" ? "customer" : "minhan";
  const isCust = state.role === "customer";

  document.getElementById("btnRoleMinhAn").classList.toggle("active", !isCust);
  document.getElementById("btnRoleCustomer").classList.toggle("active", isCust);
  document.getElementById("btnRoleCustomer").classList.toggle("customer-active", isCust);

  document.getElementById("minhAnQuickTabs").classList.toggle("hidden", isCust);
  document.getElementById("customerPortalView").classList.toggle("hidden", !isCust);
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.style.display = isCust ? "none" : "";
  });

  document.getElementById("greetingTitle").textContent = isCust
    ? "Xin chào Quý Khách hàng — Cổng Yêu cầu Báo giá Minh An"
    : "Xin chào, Đội ngũ Kinh doanh Minh An";

  renderAiQuickChips();
  if (isCust) {
    renderCustomerPortal();
  } else {
    renderAll();
  }
}

window.switchAccount = switchAccount;

function renderAiQuickChips() {
  const chips = state.role === "customer"
    ? [
        "10 Laptop ThinkPad T14 và 2 Firewall FortiGate 100F giá bao nhiêu?",
        "6 Switch Cisco 9200L có sẵn hàng giao trong 5 ngày không?",
        "Kiểm tra tiến độ OPP-2026-001"
      ]
    : [
        "Hồ sơ nào đang chờ Trưởng phòng duyệt?",
        "Có đơn nào lỗi ở Bước 5 hoặc Bước 3 không?",
        "Kiểm tra tồn kho Switch Cisco 9200L"
      ];
  document.getElementById("aiQuickChips").innerHTML = chips.map(c =>
    `<button type="button" class="chat-chip" onclick="sendQuickAi('${escapeHtml(c)}')">${escapeHtml(c)}</button>`
  ).join("");
  document.getElementById("aiChatSub").textContent = state.role === "customer"
    ? "Chế độ Khách hàng B2B • Tra giá, tồn kho & theo dõi đơn"
    : "Chế độ Doanh nghiệp Minh An • Điều phối 8 bước quy trình";
}

function renderAiMessages() {
  const box = document.getElementById("aiChatMessages");
  if (!state.chatMessages.length) {
    state.chatMessages.push({
      sender: "bot",
      text: "Xin chào! Tôi là Minh An AI Agent tương tác. Bạn có thể bấm các nút gợi ý bên dưới, bấm trực tiếp vào từng bước trên sơ đồ quy trình, hoặc gõ câu hỏi bất kỳ!"
    });
  }
  box.innerHTML = state.chatMessages.map(m => {
    let extra = "";
    if (m.suggested_action === "prefill_customer_request" && m.draft_text) {
      extra = `<div style="margin-top:8px;"><button type="button" class="btn btn-dark btn-sm" onclick="submitAiDraftFromCustomer('${escapeHtml(m.draft_text)}')">📨 Gửi ngay yêu cầu này tới Minh An</button></div>`;
    } else if (m.suggested_action === "tab_approvals") {
      extra = `<div style="margin-top:8px;"><button type="button" class="btn btn-dark btn-sm" onclick="switchAccount('minhan');switchTab('approvals')">👔 Mở Cổng Trưởng phòng duyệt</button></div>`;
    } else if (m.suggested_action === "tab_tracker") {
      extra = `<div style="margin-top:8px;"><button type="button" class="btn btn-dark btn-sm" onclick="switchAccount('minhan');switchTab('tracker')">📋 Mở Danh sách Hồ sơ</button></div>`;
    } else if (m.opp_id) {
      extra = `<div style="margin-top:8px;"><button type="button" class="btn btn-soft btn-sm" onclick="inspectOpp('${escapeHtml(m.opp_id)}')">🔍 Mở hồ sơ ${escapeHtml(m.opp_id)}</button></div>`;
    }
    return `<div class="chat-msg ${m.sender}">${escapeHtml(m.text)}${extra}</div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

function openAiChat() {
  document.getElementById("aiChatPanel").classList.remove("hidden");
  renderAiQuickChips();
  renderAiMessages();
}

window.sendQuickAi = function (text) {
  document.getElementById("aiChatInput").value = text;
  sendAiChatMessage(text);
};

window.askAiAboutOpp = function (oppId) {
  openAiChat();
  const q = `Kiểm tra trạng thái hồ sơ ${oppId}`;
  sendAiChatMessage(q);
};

window.submitAiDraftFromCustomer = async function (rawText) {
  const res = await apiPost("/api/process", {
    request_id: "AI-CHAT-" + Date.now(),
    channel: "Web Form",
    customer_company: document.getElementById("custCompany").value || "Khách hàng từ AI Chat",
    contact_name: document.getElementById("custContact").value || "Quý khách hàng",
    contact_email: document.getElementById("custEmail").value || "khach@company.vn",
    raw_content: rawText
  });
  await loadState(res.opportunity.id);
  showToast(`Đã tạo hồ sơ ${res.opportunity.id} từ AI Chat!`);
};

async function sendAiChatMessage(text) {
  if (!text.trim()) return;
  state.chatMessages.push({ sender: "user", text });
  renderAiMessages();
  document.getElementById("aiChatInput").value = "";

  try {
    const res = await apiPost("/api/ai-chat", {
      role: state.role,
      message: text,
      opp_id: state.activeOpp?.id || null
    });
    state.chatMessages.push({
      sender: "bot",
      text: res.reply,
      suggested_action: res.suggested_action,
      draft_text: res.draft_text,
      opp_id: res.opp_id
    });
  } catch (err) {
    state.chatMessages.push({ sender: "bot", text: "Lỗi kết nối AI: " + err.message });
  }
  renderAiMessages();
}

function renderAll() {
  renderHeroKpis();
  renderSummary4Grid();
  renderPipelineMatrix();
  renderSamples();
  renderResult(state.activeOpp);
  renderRightRail();
  renderTracker();
  renderApprovals();
  renderMasterData();
  renderCustomerPortal();
}

function switchTab(tabName) {
  document.querySelectorAll(".rail-btn[data-tab], .qtab[data-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.toggle("active", p.id === `tab-${tabName}`);
  });
}

window.switchTab = switchTab;

window.inspectOpp = function (oppId) {
  const found = state.opportunities.find(o => o.id === oppId);
  if (found) {
    state.activeOpp = found;
    renderResult(found);
    switchTab("workflow");
  }
};

window.openClarifyModal = function (oppId) {
  const found = state.opportunities.find(o => o.id === oppId);
  if (!found) return;
  document.getElementById("clarifyOppId").value = oppId;
  document.getElementById("clarifyModalSubtitle").textContent = `Hồ sơ ${oppId} (${found.customer_company}) đang thiếu: ${(found.missing_fields || []).join(", ")}`;
  document.getElementById("clarifyModal").classList.remove("hidden");
};

window.openNegotiateModal = function (oppId, mode = "negotiate") {
  const found = state.opportunities.find(o => o.id === oppId);
  if (!found) return;
  document.getElementById("negotiateOppId").value = oppId;
  document.getElementById("negotiateMode").value = mode;
  document.getElementById("negotiateModalTitle").textContent = mode === "revise"
    ? "Con người Kiểm tra & Chỉnh sửa Đề xuất (Bước 7 -> 6)"
    : "NVKD Thương thảo Phương án Thay thế (Bước 5 -> 6)";
  document.getElementById("negotiateModalSubtitle").textContent = mode === "revise"
    ? `Hồ sơ ${oppId} bị Trưởng phòng từ chối/yêu cầu sửa. Điều chỉnh chiết khấu hoặc điều kiện để trình lại.`
    : `Hồ sơ ${oppId} chưa đáp ứng tiến độ (${found.requested_deadline_days} ngày < ${found.max_feasible_days} ngày khả thi). Cập nhật kết quả thương thảo với KH.`;
  document.getElementById("negotiateDays").value = Math.max(found.max_feasible_days || 16, found.requested_deadline_days || 16);
  document.getElementById("negotiateDiscount").value = mode === "revise" ? 5 : (found.requested_discount_pct ?? 4);
  document.getElementById("negotiateModal").classList.remove("hidden");
};

window.submitManagerDecision = async function (oppId, decision) {
  const note = decision === "APPROVE"
    ? "Đồng ý phê duyệt phương án & chiết khấu theo thẩm quyền Trưởng phòng."
    : "Đề nghị thương lượng lại mức chiết khấu <= 5% hoặc giãn tiến độ bàn giao.";
  const res = await apiPost("/api/manager-decision", {
    opportunity_id: oppId,
    decision,
    note
  });
  await loadState(res.opportunity.id);
  showToast(decision === "APPROVE" ? `Đã phê duyệt ${oppId}` : `Đã yêu cầu điều chỉnh ${oppId}`);
};

async function loadState(selectOppId = null) {
  const data = await apiGet("/api/state");
  state.base = data.base;
  state.opportunities = data.opportunities || [];
  if (selectOppId) {
    state.activeOpp = state.opportunities.find(o => o.id === selectOppId) || state.activeOpp;
  } else if (!state.activeOpp && state.opportunities.length) {
    state.activeOpp = state.opportunities[0];
  }
  document.getElementById("priceVersionLabel").textContent = state.base.company.active_price_list_version;
  renderAll();
}

function updateGeminiBadge() {
  document.getElementById("geminiModeChip").textContent = state.geminiApiKey ? "Live Gemini AI" : "Offline Engine";
}

document.addEventListener("DOMContentLoaded", async () => {
  updateGeminiBadge();

  document.querySelectorAll(".rail-btn[data-tab], .qtab[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (state.role !== "minhan") switchAccount("minhan");
      switchTab(btn.dataset.tab);
    });
  });

  document.getElementById("btnRoleMinhAn").addEventListener("click", () => switchAccount("minhan"));
  document.getElementById("btnRoleCustomer").addEventListener("click", () => switchAccount("customer"));

  document.getElementById("btnAddCustItem").addEventListener("click", () => {
    const sku = document.getElementById("custCatalogSelect").value;
    const qty = Math.max(1, Number(document.getElementById("custItemQty").value) || 1);
    const existing = state.custItems.find(x => x.sku === sku);
    if (existing) existing.quantity += qty;
    else state.custItems.push({ sku, quantity: qty });
    renderCustomerPortal();
  });

  document.getElementById("customerRequestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.custItems.length) {
      alert("Vui lòng thêm ít nhất 1 sản phẩm/dịch vụ!");
      return;
    }
    const catalogMap = {};
    (state.base?.catalog || []).forEach(c => { catalogMap[c.sku] = c; });
    const itemsText = state.custItems.map(it => `${it.quantity} ${catalogMap[it.sku]?.name || it.sku}`).join(", ");
    const budget = Number(document.getElementById("custBudgetMillions").value);
    const days = Number(document.getElementById("custDeadlineDays").value);
    const discount = Number(document.getElementById("custDiscountPct").value) || 0;
    const approver = document.getElementById("custApprover").value.trim();
    const notes = document.getElementById("custNotes").value.trim();

    const parts = [`Công ty mình cần báo giá: ${itemsText}.`];
    if (budget > 0) parts.push(`Ngân sách dự kiến khoảng ${budget} triệu VND.`);
    if (days > 0) parts.push(`Thời hạn cần bàn giao trong vòng ${days} ngày.`);
    if (discount > 0) parts.push(`Đề nghị chiết khấu ${discount}%.`);
    if (approver) parts.push(`Người phê duyệt ngân sách là ${approver}.`);
    else parts.push(`Chưa rõ ai duyệt.`);
    if (notes) parts.push(notes);

    const res = await apiPost("/api/process", {
      request_id: "CUST-" + Date.now(),
      channel: "Web Form",
      customer_company: document.getElementById("custCompany").value,
      contact_name: document.getElementById("custContact").value,
      contact_email: document.getElementById("custEmail").value,
      raw_content: parts.join(" ")
    });
    await loadState(res.opportunity.id);
    showToast(`Đã gửi yêu cầu ${res.opportunity.id} tới Minh An!`);
  });

  document.getElementById("aiFab").addEventListener("click", () => {
    const panel = document.getElementById("aiChatPanel");
    if (panel.classList.contains("hidden")) openAiChat();
    else panel.classList.add("hidden");
  });

  document.getElementById("btnCloseAiChat").addEventListener("click", () => {
    document.getElementById("aiChatPanel").classList.add("hidden");
  });

  document.getElementById("aiChatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendAiChatMessage(document.getElementById("aiChatInput").value);
  });

  document.getElementById("globalSearchInput").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderTracker();
    renderApprovals();
    renderMasterData();
    renderCustomerPortal();
  });

  document.getElementById("btnToggleGemini").addEventListener("click", () => {
    document.getElementById("geminiDrawer").classList.toggle("hidden");
    document.getElementById("geminiApiKeyInput").value = state.geminiApiKey;
  });

  document.getElementById("btnSaveGeminiKey").addEventListener("click", () => {
    state.geminiApiKey = document.getElementById("geminiApiKeyInput").value.trim();
    localStorage.setItem("minhan_gemini_key", state.geminiApiKey);
    updateGeminiBadge();
    document.getElementById("geminiDrawer").classList.add("hidden");
    showToast("Đã bật Live Gemini AI");
  });

  document.getElementById("btnClearGeminiKey").addEventListener("click", () => {
    state.geminiApiKey = "";
    localStorage.removeItem("minhan_gemini_key");
    document.getElementById("geminiApiKeyInput").value = "";
    updateGeminiBadge();
    document.getElementById("geminiDrawer").classList.add("hidden");
    showToast("Đã chuyển về Offline Engine");
  });

  document.getElementById("btnCloseClarify").addEventListener("click", () => {
    document.getElementById("clarifyModal").classList.add("hidden");
  });

  document.getElementById("btnCloseNegotiate").addEventListener("click", () => {
    document.getElementById("negotiateModal").classList.add("hidden");
  });

  document.getElementById("btnResetDb").addEventListener("click", async () => {
    await apiPost("/api/reset", {});
    state.activeOpp = null;
    await loadState();
    showToast("Đã làm mới dữ liệu phiên thử nghiệm");
  });

  document.getElementById("requestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btnRunAgent");
    btn.disabled = true;
    btn.innerHTML = "<span>⏳ Đang chạy AI Agent...</span>";
    try {
      const rawContent = document.getElementById("inpRawContent").value;
      let llmExtraction = null;
      if (state.geminiApiKey) {
        llmExtraction = await extractWithGeminiIfConfigured(rawContent, state.base.catalog);
      }
      const res = await apiPost("/api/process", {
        request_id: state.selectedSampleId || "CUSTOM-" + Date.now(),
        channel: document.getElementById("inpChannel").value,
        customer_company: document.getElementById("inpCompany").value,
        contact_name: document.getElementById("inpContactName").value,
        contact_email: document.getElementById("inpContactEmail").value,
        raw_content: rawContent,
        llm_extraction: llmExtraction
      });
      await loadState(res.opportunity.id);
      showToast(`Đã xử lý ${res.opportunity.id} — ${res.opportunity.status_label}`);
    } catch (err) {
      alert("Lỗi xử lý: " + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = "<span>⚡ Chạy AI Agent Xử lý Quy trình</span>";
    }
  });

  document.getElementById("clarifyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const oppId = document.getElementById("clarifyOppId").value;
    const res = await apiPost("/api/clarify", {
      opportunity_id: oppId,
      clarification_patch: {
        budget_vnd: Number(document.getElementById("clarifyBudget").value),
        requested_deadline_days: Number(document.getElementById("clarifyDays").value),
        approver_name: document.getElementById("clarifyApprover").value,
        requested_discount_pct: Number(document.getElementById("clarifyDiscount").value)
      }
    });
    document.getElementById("clarifyModal").classList.add("hidden");
    await loadState(res.opportunity.id);
    if (state.role === "minhan") switchTab("workflow");
    showToast(`Đã cập nhật bổ sung cho ${oppId}`);
  });

  document.getElementById("negotiateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const oppId = document.getElementById("negotiateOppId").value;
    const mode = document.getElementById("negotiateMode").value;
    const endpoint = mode === "revise" ? "/api/revise" : "/api/negotiate";
    const res = await apiPost(endpoint, {
      opportunity_id: oppId,
      clarification_patch: {
        requested_deadline_days: Number(document.getElementById("negotiateDays").value),
        requested_discount_pct: Number(document.getElementById("negotiateDiscount").value),
        accept_current_price: document.getElementById("negotiateAcceptCurrentPrice").checked,
        accept_partial_delivery: document.getElementById("negotiatePartialDelivery").checked
      }
    });
    document.getElementById("negotiateModal").classList.add("hidden");
    await loadState(res.opportunity.id);
    if (state.role === "minhan") switchTab("workflow");
    showToast(`Đã cập nhật & chạy lại quy trình cho ${oppId}`);
  });

  try {
    await loadState();
    const firstBtn = document.querySelector(".sample-btn");
    if (firstBtn) firstBtn.click();
  } catch (err) {
    document.getElementById("serverStatusText").textContent = "Mất kết nối Localhost";
    document.getElementById("serverDot").className = "status-dot down";
  }
});
