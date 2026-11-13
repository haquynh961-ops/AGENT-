param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataFile = Join-Path $RootDir "data\minh_an_data.json"
$DbFile = Join-Path $RootDir "data\opportunities_db.json"
$WebDir = Join-Path $RootDir "web"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8File([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8File([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Load-BaseData {
    $raw = Read-Utf8File $DataFile
    return $raw | ConvertFrom-Json
}

function Ensure-Db {
    if (-not (Test-Path $DbFile)) {
        $init = @{
            next_seq = 1
            opportunities = @()
        } | ConvertTo-Json -Depth 10
        Write-Utf8File $DbFile $init
    }
}

function Load-Db {
    Ensure-Db
    $raw = Read-Utf8File $DbFile
    $db = $raw | ConvertFrom-Json
    if ($null -eq $db.opportunities) {
        $db | Add-Member -NotePropertyName "opportunities" -NotePropertyValue @() -Force
    }
    return $db
}

function Save-Db($Db) {
    $json = $Db | ConvertTo-Json -Depth 12
    Write-Utf8File $DbFile $json
}

function Normalize-Text([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    $lower = $Text.ToLowerInvariant()
    $normalized = $lower.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $normalized.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($ch)
        }
    }
    return $sb.ToString().Replace([char]0x0111, 'd')
}

function Extract-BudgetVnd([string]$Text) {
    $norm = Normalize-Text $Text
    # Match patterns like "600 trieu", "1.2 ty", "350tr", "500,000,000 vnd"
    $mTy = [regex]::Match($norm, '(?:ngan sach|toi da|du kien|khoang|budget)[^\d]{0,25}(\d+(?:[.,]\d+)?)\s*(?:ty|ti)\b')
    if (-not $mTy.Success) {
        $mTy = [regex]::Match($norm, '(\d+(?:[.,]\d+)?)\s*(?:ty|ti)\s*(?:vnd|dong)?')
    }
    if ($mTy.Success) {
        $val = [double]($mTy.Groups[1].Value.Replace(',', '.'))
        return [long][Math]::Round($val * 1000000000)
    }

    $mTr = [regex]::Match($norm, '(?:ngan sach|toi da|du kien|khoang|budget)[^\d]{0,25}(\d+(?:[.,]\d+)?)\s*(?:trieu|tr)\b')
    if (-not $mTr.Success) {
        $mTr = [regex]::Match($norm, '(\d+(?:[.,]\d+)?)\s*(?:trieu|tr)\s*(?:vnd|dong)?')
    }
    if ($mTr.Success) {
        $val = [double]($mTr.Groups[1].Value.Replace(',', '.'))
        return [long][Math]::Round($val * 1000000)
    }

    $mVnd = [regex]::Match($norm, '(\d{1,3}(?:[.,]\d{3}){2,})\s*(?:vnd|d|dong)?')
    if ($mVnd.Success) {
        $digits = $mVnd.Groups[1].Value -replace '[.,]', ''
        return [long]$digits
    }
    return $null
}

function Extract-DiscountPct([string]$Text) {
    $norm = Normalize-Text $Text
    $m = [regex]::Match($norm, '(?:chiet khau|ck|giam gia|discount)[^\d%]{0,20}(\d+(?:[.,]\d+)?)\s*%')
    if ($m.Success) {
        return [double]($m.Groups[1].Value.Replace(',', '.'))
    }
    return 0
}

function Extract-DeadlineInfo([string]$Text) {
    $norm = Normalize-Text $Text
    $days = $null
    $label = $null

    $mDays = [regex]::Match($norm, '(?:trong vong|trong|toi da)\s*(\d+)\s*ngay')
    if ($mDays.Success) {
        $days = [int]$mDays.Groups[1].Value
        $label = "$days ngày"
    }

    $mDate = [regex]::Match($norm, '(?:truoc|han|deadline|ngay)\s*(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?')
    if ($mDate.Success) {
        $d = [int]$mDate.Groups[1].Value
        $m = [int]$mDate.Groups[2].Value
        $y = if ($mDate.Groups[3].Success) { [int]$mDate.Groups[3].Value } else { 2026 }
        if ($y -lt 100) { $y += 2000 }
        try {
            $target = New-Object DateTime($y, $m, $d)
            $today = (Get-Date).Date
            $diff = [int][Math]::Ceiling(($target - $today).TotalDays)
            if ($diff -lt 1) { $diff = 1 }
            if ($null -eq $days) { $days = $diff }
            $label = $target.ToString("dd/MM/yyyy") + " ($days ngày)"
        } catch {}
    }

    if ($null -eq $days -and $norm -match 'trong thang nay|thang nay|som nhat|can gap') {
        $label = "Chưa cụ thể ngày (cần chốt ngày chính xác)"
    }

    return @{
        days = $days
        text = $label
    }
}

function Extract-ApproverInfo([string]$Text, [string]$ContactName, [string]$ContactEmail) {
    $norm = Normalize-Text $Text
    if ($norm -match 'chua chot|chua ro ai duyet|chua ro nguoi duyet|di cong tac chua chot|chua xac dinh nguoi ky') {
        return @{
            identified = $false
            name = $null
        }
    }
    $m = [regex]::Match($Text, '(?:phê duyệt|duyệt ngân sách|duyệt hợp đồng|ký duyệt|người phê duyệt)[^.\n]{0,80}', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($m.Success) {
        return @{
            identified = $true
            name = $m.Value.Trim()
        }
    }
    if ($norm -match 'giam doc|ceo|truong phong|pho giam doc|cfo') {
        return @{
            identified = $true
            name = $(if ($ContactName) { $ContactName } else { "Cấp quản lý đã nêu trong yêu cầu" })
        }
    }
    return @{
        identified = $false
        name = $null
    }
}

function Extract-CatalogItems([string]$Text, $Catalog) {
    $normText = Normalize-Text $Text
    $found = @()
    $seenSkus = @{}

    foreach ($item in $Catalog) {
        $patterns = @($item.name) + @($item.aliases)
        foreach ($p in $patterns) {
            $normP = Normalize-Text $p
            if ([string]::IsNullOrWhiteSpace($normP)) { continue }
            $escaped = [regex]::Escape($normP)
            $regex = "(?:\b|^)(\d+)\b\s*(?:bo|chiec|cai|thiet bi|goi|may)?\s*(?:[a-z\s\-/()]{0,18})?" + $escaped
            $m = [regex]::Match($normText, $regex)
            if ($m.Success -and -not $seenSkus.ContainsKey($item.sku)) {
                $qty = [int]$m.Groups[1].Value
                $seenSkus[$item.sku] = $true
                $found += [pscustomobject]@{
                    sku = $item.sku
                    raw_name = $p
                    quantity = $qty
                }
                break
            }
            if ($normText.Contains($normP) -and -not $seenSkus.ContainsKey($item.sku)) {
                $seenSkus[$item.sku] = $true
                $found += [pscustomobject]@{
                    sku = $item.sku
                    raw_name = $p
                    quantity = 1
                }
                break
            }
        }
    }
    return $found
}

function Pick-SalesOwner($SalesTeam, $Db, $ExtractedItems, $CatalogMap) {
    $counts = @{}
    foreach ($rep in $SalesTeam) {
        $counts[$rep.id] = [int]$rep.active_deals
    }
    foreach ($opp in $Db.opportunities) {
        if ($opp.owner_id -and $counts.ContainsKey($opp.owner_id) -and $opp.status -ne "COMPLETED") {
            $counts[$opp.owner_id] = $counts[$opp.owner_id] + 1
        }
    }

    $primaryCategory = ""
    if ($ExtractedItems.Count -gt 0) {
        $firstSku = $ExtractedItems[0].sku
        if ($CatalogMap.ContainsKey($firstSku)) {
            $primaryCategory = $CatalogMap[$firstSku].category
        }
    }

    $ranked = $SalesTeam | Sort-Object {
        $rep = $_
        $load = $counts[$rep.id]
        $bonus = 0
        $specNorm = Normalize-Text $rep.specialty
        if ($primaryCategory -eq "Server" -and $specNorm -match "server") { $bonus = -2 }
        elseif (($primaryCategory -eq "Network" -or $primaryCategory -eq "Security") -and $specNorm -match "mang|bao mat") { $bonus = -2 }
        elseif ($primaryCategory -eq "Endpoint" -and $specNorm -match "laptop|dau cuoi") { $bonus = -2 }
        elseif ($primaryCategory -eq "Service" -and $specNorm -match "dich vu|trien khai") { $bonus = -2 }
        $load + $bonus
    }
    $chosen = $ranked[0]
    return [pscustomobject]@{
        id = $chosen.id
        name = $chosen.name
        email = $chosen.email
        specialty = $chosen.specialty
        current_load = $counts[$chosen.id]
    }
}

function Evaluate-Workflow($Payload, $BaseData, $Db, $ExistingOpp) {
    $catalog = $BaseData.catalog
    $policy = $BaseData.authority_policy
    $catalogMap = @{}
    foreach ($c in $catalog) { $catalogMap[$c.sku] = $c }

    $rawContent = [string]$Payload.raw_content
    $customerCompany = if ($Payload.customer_company) { [string]$Payload.customer_company } else { "Khách hàng doanh nghiệp" }
    $contactName = if ($Payload.contact_name) { [string]$Payload.contact_name } else { "Quý khách hàng" }
    $contactEmail = if ($Payload.contact_email) { [string]$Payload.contact_email } else { "contact@customer.vn" }
    $channel = if ($Payload.channel) { [string]$Payload.channel } else { "Email" }

    # Allow structured override from Live Gemini Mode or Clarification form
    $parsed = $Payload.llm_extraction
    if ($null -ne $parsed) {
        $extractedItems = @()
        foreach ($it in $parsed.items) {
            $matchedSku = $null
            if ($it.sku -and $catalogMap.ContainsKey($it.sku)) {
                $matchedSku = $it.sku
            } else {
                $normRaw = Normalize-Text $it.raw_name
                foreach ($c in $catalog) {
                    $allNames = @($c.name) + @($c.aliases)
                    foreach ($nm in $allNames) {
                        if ($normRaw.Contains((Normalize-Text $nm)) -or (Normalize-Text $nm).Contains($normRaw)) {
                            $matchedSku = $c.sku
                            break
                        }
                    }
                    if ($matchedSku) { break }
                }
            }
            if ($matchedSku) {
                $extractedItems += [pscustomobject]@{
                    sku = $matchedSku
                    raw_name = $it.raw_name
                    quantity = if ($null -ne $it.quantity) { [int]$it.quantity } else { 1 }
                }
            }
        }
        $budgetVnd = if ($null -ne $parsed.budget_vnd) { [long]$parsed.budget_vnd } else { $null }
        $deadlineDays = if ($null -ne $parsed.requested_deadline_days) { [int]$parsed.requested_deadline_days } else { $null }
        $deadlineText = if ($parsed.requested_deadline_text) { [string]$parsed.requested_deadline_text } else { $null }
        $discountPct = if ($null -ne $parsed.requested_discount_pct) { [double]$parsed.requested_discount_pct } else { 0 }
        $approverIdentified = [bool]$parsed.approver_identified
        $approverName = $parsed.approver_name
        $mentionsOldPrice = [bool]$parsed.mentions_old_price
    } else {
        $extractedItems = @(Extract-CatalogItems $rawContent $catalog)
        $budgetVnd = Extract-BudgetVnd $rawContent
        $dlInfo = Extract-DeadlineInfo $rawContent
        $deadlineDays = $dlInfo.days
        $deadlineText = $dlInfo.text
        $discountPct = Extract-DiscountPct $rawContent
        $appInfo = Extract-ApproverInfo $rawContent $contactName $contactEmail
        $approverIdentified = $appInfo.identified
        $approverName = $appInfo.name
        $normRaw = Normalize-Text $rawContent
        $mentionsOldPrice = ($normRaw -match 'gia cu|thang 8|bao gia cu|bang gia cu')
    }

    # Apply explicit clarification overrides if looping back from customer reply
    if ($null -ne $Payload.clarification_patch) {
        $patch = $Payload.clarification_patch
        if ($null -ne $patch.budget_vnd -and [long]$patch.budget_vnd -gt 0) {
            $budgetVnd = [long]$patch.budget_vnd
        }
        if ($null -ne $patch.requested_deadline_days -and [int]$patch.requested_deadline_days -gt 0) {
            $deadlineDays = [int]$patch.requested_deadline_days
            $deadlineText = "$deadlineDays ngày (KH đã xác nhận)"
        }
        if (-not [string]::IsNullOrWhiteSpace($patch.approver_name)) {
            $approverIdentified = $true
            $approverName = [string]$patch.approver_name
        }
        if ($null -ne $patch.requested_discount_pct) {
            $discountPct = [double]$patch.requested_discount_pct
        }
        if ($patch.accept_current_price -eq $true) {
            $mentionsOldPrice = $false
        }
    }

    # Step 2: Completeness Gate
    $missingFields = @()
    if ($extractedItems.Count -eq 0) { $missingFields += "Danh sách sản phẩm/dịch vụ & số lượng cụ thể" }
    if ($null -eq $budgetVnd -or $budgetVnd -le 0) { $missingFields += "Ngân sách tổng dự kiến (VND)" }
    if ($null -eq $deadlineDays -or $deadlineDays -le 0) { $missingFields += "Thời hạn triển khai / ngày bàn giao cụ thể" }
    if (-not $approverIdentified) { $missingFields += "Người phê duyệt / đầu mối quyết định ngân sách" }

    $isComplete = ($missingFields.Count -eq 0)

    # Assign owner (keep existing owner if looping back)
    if ($null -ne $ExistingOpp) {
        $owner = [pscustomobject]@{
            id = $ExistingOpp.owner_id
            name = $ExistingOpp.owner_name
            email = $ExistingOpp.owner_email
            specialty = $ExistingOpp.owner_specialty
        }
        $oppId = $ExistingOpp.id
    } else {
        $owner = Pick-SalesOwner $BaseData.sales_team $Db $extractedItems $catalogMap
        $seq = [int]$Db.next_seq
        $oppId = "OPP-2026-" + $seq.ToString("000")
        $Db.next_seq = $seq + 1
    }

    $nowIso = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss+07:00")

    # Step 3a: Incomplete -> Clarification Loop & Anti-Orphan Tracking
    if (-not $isComplete) {
        $itemBullet = if ($extractedItems.Count -gt 0) {
            ($extractedItems | ForEach-Object { "- $($catalogMap[$_.sku].name): $($_.quantity) $($catalogMap[$_.sku].unit)" }) -join "`n"
        } else {
            "- (Chưa nhận diện được mã sản phẩm cụ thể từ yêu cầu)"
        }
        $missingBullet = ($missingFields | ForEach-Object { "- $_" }) -join "`n"
        $clarificationEmail = @"
Kính gửi $contactName ($customerCompany),

Em là $($owner.name) - Phụ trách Kinh doanh tại Công ty Công nghệ Minh An (Hồ sơ theo dõi: $oppId).
Minh An đã tiếp nhận đầy đủ danh sách hạng mục Anh/Chị quan tâm:
$itemBullet

Để bộ phận Kinh doanh và Vận hành thẩm định tồn kho, giữ hàng và lập báo giá chính xác theo bảng giá hiện hành ($($BaseData.company.active_price_list_version)), Anh/Chị vui lòng bổ sung giúp bên em các thông tin sau:
$missingBullet

Ngay khi nhận được phản hồi, bên em sẽ gửi dự thảo báo giá chi tiết trong vòng 30 phút.
Trân trọng,
$($owner.name) | $($owner.email)
"@

        $stepsTrail = @(
            @{ step = 1; code = "RECEIVE"; actor = "AI"; title = "Tiếp nhận yêu cầu"; status = "done"; detail = "Nhận từ $channel ($customerCompany)" },
            @{ step = 2; code = "TRIAGE"; actor = "Con người & AI"; title = "Phân loại & Kiểm tra thông tin"; status = "warning"; detail = "Nhánh có lỗi: Thiếu $($missingFields.Count)/4 nhóm thông tin" },
            @{ step = 3; code = "CLARIFY"; actor = "NVKD & AI"; title = "Yêu cầu KH làm rõ/bổ sung"; status = "active"; detail = "Trạng thái Chờ bổ sung ($oppId -> $($owner.name), SLA 24h)" },
            @{ step = 4; code = "ASSIGN"; actor = "AI"; title = "Tạo Hồ sơ & Gán phụ trách"; status = "pending"; detail = "Chờ KH phản hồi để quay lại Bước 2" },
            @{ step = 5; code = "OPS_CHECK"; actor = "AI"; title = "Thẩm định tồn kho & giá"; status = "pending"; detail = "Chưa thực hiện" },
            @{ step = 6; code = "PROPOSAL"; actor = "AI"; title = "Lập Báo giá & Dự thảo đề xuất"; status = "pending"; detail = "Chưa thực hiện" },
            @{ step = 7; code = "APPROVAL"; actor = "Trưởng phòng"; title = "Trưởng phòng duyệt?"; status = "pending"; detail = "Chưa thực hiện" },
            @{ step = 8; code = "TRACK"; actor = "Con người & AI"; title = "Cập nhật & Theo dõi"; status = "pending"; detail = "Chờ hoàn tất" }
        )

        return [pscustomobject]@{
            id = $oppId
            source_request_id = $Payload.request_id
            channel = $channel
            created_at = if ($ExistingOpp) { $ExistingOpp.created_at } else { $nowIso }
            updated_at = $nowIso
            customer_company = $customerCompany
            contact_name = $contactName
            contact_email = $contactEmail
            raw_content = $rawContent
            owner_id = $owner.id
            owner_name = $owner.name
            owner_email = $owner.email
            owner_specialty = $owner.specialty
            status = "WAITING_CLARIFICATION"
            status_label = "Cần bổ sung thông tin (Bước 3)"
            summary_bucket = "need_clarification"
            sla_hours = $policy.sla_clarification_followup_hours
            is_complete = $false
            missing_fields = $missingFields
            budget_vnd = $budgetVnd
            requested_deadline_days = $deadlineDays
            requested_deadline_text = $deadlineText
            requested_discount_pct = $discountPct
            approver_identified = $approverIdentified
            approver_name = $approverName
            mentions_old_price = $mentionsOldPrice
            clarification_email = $clarificationEmail
            negotiation_script = $null
            line_items = @()
            extracted_count = $extractedItems.Count
            quoted_count = 0
            subtotal_vnd = 0
            discount_amount_vnd = 0
            final_total_vnd = 0
            budget_gap_vnd = 0
            within_budget = $false
            max_feasible_days = 0
            deadline_feasible = $false
            requires_manager_approval = $false
            escalation_reasons = @()
            warnings = @("Nhánh có lỗi ở Bước 2 -> Rẽ sang Bước 3 (Chờ bổ sung) & gán $($owner.name) theo dõi SLA 24h.")
            proposal_draft = $null
            manager_decision = $null
            steps_trail = $stepsTrail
        }
    }

    # Step 5: Deterministic Ops Inventory & Active Price List Verification
    $lineItems = @()
    [long]$subtotal = 0
    [int]$maxFeasibleDays = 0
    $warnings = @()
    $opsIssues = @()

    if ($mentionsOldPrice) {
        $warnings += "Khách hàng đề cập bảng giá cũ ($($BaseData.company.previous_price_list_version)). Hệ thống đã KHÓA cứng theo bảng giá hiệu lực $($BaseData.company.active_price_list_version)."
    }

    $idx = 1
    foreach ($ext in $extractedItems) {
        $cat = $catalogMap[$ext.sku]
        $qty = [int]$ext.quantity
        $unitPrice = [long]$cat.current_price_vnd
        $oldUnitPrice = [long]$cat.old_price_vnd
        $lineTotal = $unitPrice * $qty
        $subtotal += $lineTotal

        $stockAvail = [int]$cat.stock_available
        $shortfall = [Math]::Max(0, $qty - $stockAvail)
        if ($shortfall -eq 0) {
            $itemFeasibleDays = [int]$cat.deploy_lead_time_days
            $stockStatus = "Đủ tồn kho ($stockAvail/$qty)"
        } else {
            $itemFeasibleDays = [int]$cat.inbound_eta_days + [int]$cat.deploy_lead_time_days
            $stockStatus = "Thiếu $shortfall $($cat.unit) (Tồn: $stockAvail, Nhập thêm sau $($cat.inbound_eta_days) ngày)"
            $opsIssues += "$($cat.name): chỉ còn $stockAvail, cần $qty (sớm nhất $itemFeasibleDays ngày)"
        }
        if ($itemFeasibleDays -gt $maxFeasibleDays) {
            $maxFeasibleDays = $itemFeasibleDays
        }

        $lineItems += [pscustomobject]@{
            line_no = $idx
            sku = $cat.sku
            name = $cat.name
            unit = $cat.unit
            quantity = $qty
            unit_price_vnd = $unitPrice
            old_price_vnd = $oldUnitPrice
            line_total_vnd = $lineTotal
            stock_available = $stockAvail
            shortfall = $shortfall
            stock_status = $stockStatus
            item_feasible_days = $itemFeasibleDays
        }
        $idx++
    }

    [long]$discountAmount = [long][Math]::Round($subtotal * ($discountPct / 100.0))
    [long]$finalTotal = $subtotal - $discountAmount
    [long]$budgetGap = $finalTotal - $budgetVnd
    $withinBudget = ($finalTotal -le $budgetVnd)
    $acceptedPartial = ($null -ne $Payload.clarification_patch -and $Payload.clarification_patch.accept_partial_delivery -eq $true)
    $deadlineFeasible = ($maxFeasibleDays -le $deadlineDays) -or $acceptedPartial

    # Step 5 Error Branch: Infeasible (Out of stock / Cannot meet deadline) -> STOP at Step 5 for NVKD negotiation!
    if (-not $deadlineFeasible) {
        $warnings += "Nhánh Lỗi ở Bước 5: Thời hạn khách yêu cầu ($deadlineDays ngày) KHÔNG đáp ứng được (tồn kho/nhập hàng cần ít nhất $maxFeasibleDays ngày). Dừng ở Bước 5 để NVKD thương thảo phương án thay thế."
        $negotiationScript = @"
[HƯỚNG DẪN NVKD THƯƠNG THẢO PHƯƠNG ÁN THAY THẾ - BƯỚC 5]
Hồ sơ: $oppId | NVKD phụ trách: $($owner.name) | Khách hàng: $customerCompany ($contactName)
Trạng thái: CHƯA ĐÁP ỨNG (Không kịp tiến độ / Thiếu tồn kho)

VẤN ĐỀ VẬN HÀNH PHÁT HIỆN:
- $($opsIssues -join "`n- ")
- Thời hạn KH yêu cầu: $deadlineDays ngày | Thời gian khả thi trọn bộ: $maxFeasibleDays ngày.

ĐỀ XUẤT THƯƠNG THẢO VỚI KHÁCH HÀNG:
1. Phương án A (Giữ nguyên cấu hình): Đề nghị khách hàng điều chỉnh mốc bàn giao toàn bộ sang $maxFeasibleDays ngày.
2. Phương án B (Giao làm 2 đợt): Giao & triển khai trước các hạng mục đủ tồn kho trong 2-3 ngày; phần còn thiếu bàn giao sau $($maxFeasibleDays) ngày.
$(if ($mentionsOldPrice) { "3. Lưu ý giá: Giải thích áp dụng bảng giá hiện hành $($BaseData.company.active_price_list_version) thay cho giá cũ tháng 8." } else { "" })
"@
        $stepsTrail = @(
            @{ step = 1; code = "RECEIVE"; actor = "AI"; title = "Tiếp nhận yêu cầu"; status = "done"; detail = "Nhận từ $channel ($customerCompany)" },
            @{ step = 2; code = "TRIAGE"; actor = "Con người & AI"; title = "Phân loại & Kiểm tra thông tin"; status = "done"; detail = "Nhánh bình thường: Đủ 4/4 nhóm thông tin" },
            @{ step = 3; code = "CLARIFY"; actor = "NVKD & AI"; title = "Yêu cầu KH làm rõ/bổ sung"; status = "skipped"; detail = "Không cần hỏi lại" },
            @{ step = 4; code = "ASSIGN"; actor = "AI"; title = "Tạo Hồ sơ & Gán phụ trách"; status = "done"; detail = "$oppId -> $($owner.name) ($($owner.id))" },
            @{ step = 5; code = "OPS_CHECK"; actor = "AI"; title = "Thẩm định tồn kho & giá"; status = "error"; detail = "Nhánh lỗi: Không đáp ứng ($maxFeasibleDays ngày > $deadlineDays ngày) -> NVKD thương thảo" },
            @{ step = 6; code = "PROPOSAL"; actor = "AI"; title = "Lập Báo giá & Dự thảo đề xuất"; status = "pending"; detail = "Chờ kết quả thương thảo Bước 5" },
            @{ step = 7; code = "APPROVAL"; actor = "Trưởng phòng"; title = "Trưởng phòng duyệt?"; status = "pending"; detail = "Chưa thực hiện" },
            @{ step = 8; code = "TRACK"; actor = "Con người & AI"; title = "Cập nhật & Theo dõi"; status = "pending"; detail = "NVKD đang liên hệ KH thương thảo" }
        )

        return [pscustomobject]@{
            id = $oppId
            source_request_id = $Payload.request_id
            channel = $channel
            created_at = if ($ExistingOpp) { $ExistingOpp.created_at } else { $nowIso }
            updated_at = $nowIso
            customer_company = $customerCompany
            contact_name = $contactName
            contact_email = $contactEmail
            raw_content = $rawContent
            owner_id = $owner.id
            owner_name = $owner.name
            owner_email = $owner.email
            owner_specialty = $owner.specialty
            status = "NOT_FEASIBLE"
            status_label = "Chưa đáp ứng (Rẽ ở Bước 5)"
            summary_bucket = "not_feasible"
            sla_hours = $policy.sla_ops_verification_hours
            is_complete = $true
            missing_fields = @()
            budget_vnd = $budgetVnd
            requested_deadline_days = $deadlineDays
            requested_deadline_text = $deadlineText
            requested_discount_pct = $discountPct
            approver_identified = $true
            approver_name = $approverName
            mentions_old_price = $mentionsOldPrice
            clarification_email = $null
            negotiation_script = $negotiationScript
            line_items = $lineItems
            extracted_count = $extractedItems.Count
            quoted_count = $lineItems.Count
            subtotal_vnd = $subtotal
            discount_amount_vnd = $discountAmount
            final_total_vnd = $finalTotal
            budget_gap_vnd = $budgetGap
            within_budget = $withinBudget
            max_feasible_days = $maxFeasibleDays
            deadline_feasible = $false
            requires_manager_approval = $false
            escalation_reasons = @()
            warnings = $warnings
            proposal_draft = $null
            manager_decision = $null
            steps_trail = $stepsTrail
        }
    }

    if (-not $withinBudget) {
        $warnings += "Tổng giá trị sau chiết khấu vượt ngân sách dự kiến của khách hàng."
    }

    # Step 6: Authority Policy Check (Discount > 5% / Complex / Old Price / > 1B)
    $escalationReasons = @()
    if ($discountPct -gt [double]$policy.sales_rep_max_discount_pct) {
        $escalationReasons += "Chiết khấu đề nghị $discountPct% vượt thẩm quyền NVKD (tối đa $($policy.sales_rep_max_discount_pct)%)"
    }
    if ($finalTotal -gt [long]$policy.auto_escalate_if_total_over_vnd) {
        $escalationReasons += "Tổng giá trị đơn hàng vượt ngưỡng $($policy.auto_escalate_if_total_over_vnd.ToString('N0')) VND"
    }
    if ($mentionsOldPrice) {
        $escalationReasons += "Khách hàng từng đề nghị áp dụng bảng giá cũ ($($BaseData.company.previous_price_list_version))"
    }

    $requiresManager = ($escalationReasons.Count -gt 0)

    # Step 6: Build Proposal Draft
    $quoteLines = ($lineItems | ForEach-Object {
        "$($_.line_no). $($_.name) | SL: $($_.quantity) $($_.unit) | Đơn giá ($($BaseData.company.active_price_list_version)): $($_.unit_price_vnd.ToString('N0')) đ | Thành tiền: $($_.line_total_vnd.ToString('N0')) đ | Kho: $($_.stock_status)"
    }) -join "`n"

    $priceNote = if ($mentionsOldPrice) {
        "`n[LƯU Ý BẢNG GIÁ]: Minh An áp dụng thống nhất bảng giá hiệu lực $($BaseData.company.active_price_list_version) (bảng giá tháng 8 đã hết hiệu lực)."
    } else { "" }

    $scheduleNote = if ($acceptedPartial) {
        "Thực hiện theo phương án đã thương thảo với KH: Giao trước các thiết bị sẵn kho trong 2-3 ngày, phần nhập bổ sung hoàn tất trong $maxFeasibleDays ngày."
    } else {
        "Cam kết hoàn tất giao hàng & triển khai trong $maxFeasibleDays ngày (đáp ứng tốt hạn $deadlineDays ngày của Quý công ty)."
    }

    $approvalHeader = if ($requiresManager) {
        "[BƯỚC 7: TRÌNH TRƯỞNG PHÒNG DUYỆT - VƯỢT THẨM QUYỀN]"
    } else {
        "[TRONG THẨM QUYỀN NVKD (CK <= $($policy.sales_rep_max_discount_pct)%) - SẴN SÀNG GỬI KHÁCH HÀNG]"
    }

    $proposalDraft = @"
$approvalHeader
Hồ sơ cơ hội: $oppId | Người phụ trách: $($owner.name) ($($owner.email))
Khách hàng: $customerCompany | Người liên hệ: $contactName | Phê duyệt: $approverName
Bảng giá áp dụng: $($BaseData.company.active_price_list_version)

DANH MỤC BÁO GIÁ ĐẦY ĐỦ ($($lineItems.Count)/$($extractedItems.Count) HẠNG MỤC - KHÔNG BỎ SÓT):
$quoteLines

TỔNG HỢP TÀI CHÍNH:
- Tổng tiền trước chiết khấu: $($subtotal.ToString('N0')) VND
- Chiết khấu đề nghị ($discountPct%): -$($discountAmount.ToString('N0')) VND
- TỔNG THANH TOÁN SAU CHIẾT KHẤU: $($finalTotal.ToString('N0')) VND
- Ngân sách dự kiến của KH: $($budgetVnd.ToString('N0')) VND ($(if ($withinBudget) { 'Trong ngân sách' } else { 'Vượt ngân sách ' + $budgetGap.ToString('N0') + ' VND' }))

PHƯƠNG ÁN TRIỂN KHAI & VẬN HÀNH:
$scheduleNote$priceNote
"@

    $statusCode = if ($requiresManager) { "PENDING_MANAGER_APPROVAL" } else { "READY_TO_SEND" }
    $statusLabel = if ($requiresManager) { "Chờ duyệt (Đang ở Bước 7)" } else { "Có thể tiếp tục (Bước 8 - Theo dõi)" }
    $summaryBucket = if ($requiresManager) { "pending_approval" } else { "can_continue" }

    $stepsTrail = @(
        @{ step = 1; code = "RECEIVE"; actor = "AI"; title = "Tiếp nhận yêu cầu"; status = "done"; detail = "Nhận từ $channel ($customerCompany)" },
        @{ step = 2; code = "TRIAGE"; actor = "Con người & AI"; title = "Phân loại & Kiểm tra thông tin"; status = "done"; detail = "Nhánh bình thường: Đủ 4/4 nhóm thông tin" },
        @{ step = 3; code = "CLARIFY"; actor = "NVKD & AI"; title = "Yêu cầu KH làm rõ/bổ sung"; status = "skipped"; detail = if ($ExistingOpp -and $ExistingOpp.status -eq "WAITING_CLARIFICATION") { "Đã hoàn tất bổ sung" } else { "Không cần hỏi lại" } },
        @{ step = 4; code = "ASSIGN"; actor = "AI"; title = "Tạo Hồ sơ & Gán phụ trách"; status = "done"; detail = "$oppId -> $($owner.name) ($($owner.id))" },
        @{ step = 5; code = "OPS_CHECK"; actor = "AI"; title = "Thẩm định tồn kho & giá"; status = "done"; detail = "Nhánh khả thi: Bảng giá $($BaseData.company.active_price_list_version) | $maxFeasibleDays ngày" },
        @{ step = 6; code = "PROPOSAL"; actor = "AI"; title = "Lập Báo giá & Dự thảo đề xuất"; status = "done"; detail = "Đối soát $($lineItems.Count)/$($extractedItems.Count) hạng mục (0% bỏ sót)" },
        @{ step = 7; code = "APPROVAL"; actor = "Trưởng phòng"; title = "Trưởng phòng duyệt?"; status = $(if ($requiresManager) { "active" } else { "skipped" }); detail = $(if ($requiresManager) { "Cần con người & phê duyệt ($($escalationReasons.Count) lý do)" } else { "CK $discountPct% <= $($policy.sales_rep_max_discount_pct)% -> Đi thẳng Bước 8" }) },
        @{ step = 8; code = "TRACK"; actor = "Con người & AI"; title = "Cập nhật & Theo dõi"; status = $(if ($requiresManager) { "pending" } else { "active" }); detail = $(if ($requiresManager) { "Chờ Trưởng phòng duyệt" } else { "Gửi báo giá, cập nhật CRM & theo dõi chốt đơn" }) }
    )

    return [pscustomobject]@{
        id = $oppId
        source_request_id = $Payload.request_id
        channel = $channel
        created_at = if ($ExistingOpp) { $ExistingOpp.created_at } else { $nowIso }
        updated_at = $nowIso
        customer_company = $customerCompany
        contact_name = $contactName
        contact_email = $contactEmail
        raw_content = $rawContent
        owner_id = $owner.id
        owner_name = $owner.name
        owner_email = $owner.email
        owner_specialty = $owner.specialty
        status = $statusCode
        status_label = $statusLabel
        summary_bucket = $summaryBucket
        sla_hours = $policy.sla_ops_verification_hours
        is_complete = $true
        missing_fields = @()
        budget_vnd = $budgetVnd
        requested_deadline_days = $deadlineDays
        requested_deadline_text = $deadlineText
        requested_discount_pct = $discountPct
        approver_identified = $true
        approver_name = $approverName
        mentions_old_price = $mentionsOldPrice
        clarification_email = $null
        negotiation_script = $null
        line_items = $lineItems
        extracted_count = $extractedItems.Count
        quoted_count = $lineItems.Count
        subtotal_vnd = $subtotal
        discount_amount_vnd = $discountAmount
        final_total_vnd = $finalTotal
        budget_gap_vnd = $budgetGap
        within_budget = $withinBudget
        max_feasible_days = $maxFeasibleDays
        deadline_feasible = $true
        requires_manager_approval = $requiresManager
        escalation_reasons = $escalationReasons
        warnings = $warnings
        proposal_draft = $proposalDraft
        manager_decision = $null
        steps_trail = $stepsTrail
    }
}

function Invoke-AiAssistantChat($Payload, $BaseData, $Db) {
    $role = if ($Payload.role -eq "customer") { "customer" } else { "minhan" }
    $msg = [string]$Payload.message
    $norm = Normalize-Text $msg
    $opps = @($Db.opportunities)
    $catalog = $BaseData.catalog

    # Check if user references a specific OPP ID
    $mOpp = [regex]::Match($msg, 'OPP-\d{4}-\d{3}', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($mOpp.Success) {
        $oppId = $mOpp.Value.ToUpperInvariant()
        $found = $opps | Where-Object { $_.id -eq $oppId } | Select-Object -First 1
        if ($null -ne $found) {
            if ($role -eq "customer") {
                $extra = if ($found.status -eq "WAITING_CLARIFICATION") {
                    "Hiện hồ sơ đang cần Anh/Chị bổ sung: " + ($found.missing_fields -join ", ") + "."
                } elseif ($found.status -eq "NOT_FEASIBLE") {
                    "Tiến độ kho hiện cần tối thiểu $($found.max_feasible_days) ngày (yêu cầu $($found.requested_deadline_days) ngày). NVKD $($found.owner_name) đang có phương án giao 2 đợt hoặc lùi lịch."
                } elseif ($found.status -eq "PENDING_MANAGER_APPROVAL") {
                    "Đề xuất đang chờ Trưởng phòng Kinh doanh Minh An duyệt mức chiết khấu $($found.requested_discount_pct)%."
                } else {
                    "Báo giá đã sẵn sàng ($($found.final_total_vnd.ToString('N0')) VND), phụ trách: $($found.owner_name)."
                }
                return @{
                    reply = "Hồ sơ **$($found.id)** ($($found.customer_company)) đang ở trạng thái: **$($found.status_label)**. $extra"
                    opp_id = $found.id
                    suggested_action = if ($found.status -eq "WAITING_CLARIFICATION") { "clarify" } elseif ($found.status -eq "NOT_FEASIBLE") { "negotiate" } else { "inspect" }
                }
            } else {
                return @{
                    reply = "Hồ sơ **$($found.id)** ($($found.customer_company)) | NVKD: **$($found.owner_name)** | Trạng thái: **$($found.status_label)** | Hạng mục: $($found.quoted_count)/$($found.extracted_count) | Tổng sau CK ($($found.requested_discount_pct)%): **$($found.final_total_vnd.ToString('N0')) VND**."
                    opp_id = $found.id
                    suggested_action = "inspect"
                }
            }
        }
    }

    # Product / stock / price inquiry
    $mentionedItems = @(Extract-CatalogItems $msg $catalog)
    if ($mentionedItems.Count -gt 0) {
        $catalogMap = @{}
        foreach ($c in $catalog) { $catalogMap[$c.sku] = $c }
        $lines = @()
        [long]$estTotal = 0
        [int]$maxDays = 0
        foreach ($mi in $mentionedItems) {
            $cat = $catalogMap[$mi.sku]
            $qty = [int]$mi.quantity
            $sub = [long]$cat.current_price_vnd * $qty
            $estTotal += $sub
            $days = if ($qty -le [int]$cat.stock_available) { [int]$cat.deploy_lead_time_days } else { [int]$cat.inbound_eta_days + [int]$cat.deploy_lead_time_days }
            if ($days -gt $maxDays) { $maxDays = $days }
            $stockNote = if ($qty -le [int]$cat.stock_available) { "Đủ tồn kho ($($cat.stock_available))" } else { "Kho chỉ còn $($cat.stock_available), nhập thêm sau $($cat.inbound_eta_days) ngày" }
            $lines += "- $($cat.name) (SL: $qty): $($cat.current_price_vnd.ToString('N0')) đ/$($cat.unit) — $stockNote (khả thi ~$days ngày)"
        }
        $budget = Extract-BudgetVnd $msg
        $dl = Extract-DeadlineInfo $msg
        $missing = @()
        if ($null -eq $budget) { $missing += "Ngân sách tổng" }
        if ($null -eq $dl.days) { $missing += "Thời hạn triển khai" }
        $missing += "Người phê duyệt"

        $replyText = "Tôi đã tra bảng giá hiệu lực **$($BaseData.company.active_price_list_version)** và tồn kho Vận hành:`n" + ($lines -join "`n") + "`nTổng tạm tính (chưa CK): **$($estTotal.ToString('N0')) VND** | Thời gian giao trọn bộ sớm nhất: **$maxDays ngày**."
        if ($role -eq "customer") {
            $replyText += "`n👉 Bạn có thể bấm nút bên dưới để chuyển nội dung này thành **Yêu cầu Báo giá chính thức** gửi sang Minh An!"
        }
        return @{
            reply = $replyText
            can_create_request = $true
            draft_text = $msg
            suggested_action = if ($role -eq "customer") { "prefill_customer_request" } else { "prefill_minhan_request" }
        }
    }

    # Internal Minh An summary queries
    if ($role -eq "minhan") {
        if ($norm -match 'duyet|vuot quyen|truong phong|buoc 7') {
            $pending = @($opps | Where-Object { $_.status -eq "PENDING_MANAGER_APPROVAL" })
            if ($pending.Count -eq 0) {
                return @{ reply = "Hiện chưa có hồ sơ nào chờ Trưởng phòng duyệt ở Bước 7. Bạn có thể chạy thử **Mẫu 1 (CK 8%)** để kiểm tra luồng vượt quyền." }
            }
            $listTxt = ($pending | ForEach-Object { "- **$($_.id)** ($($_.customer_company)) — CK $($_.requested_discount_pct)% — $($_.final_total_vnd.ToString('N0')) VND" }) -join "`n"
            return @{ reply = "Có **$($pending.Count)** hồ sơ đang chờ Trưởng phòng duyệt tại Bước 7:`n$listTxt"; suggested_action = "tab_approvals" }
        }
        if ($norm -match 'loi|chua dap ung|buoc 5|het hang|bo sung|buoc 3') {
            $s3 = @($opps | Where-Object { $_.status -eq "WAITING_CLARIFICATION" })
            $s5 = @($opps | Where-Object { $_.status -eq "NOT_FEASIBLE" })
            return @{
                reply = "Tình hình ngoại lệ hiện tại:`n- **Bước 3 (Cần bổ sung thông tin):** $($s3.Count) hồ sơ`n- **Bước 5 (Chưa đáp ứng / Lỗi tồn kho-tiến độ):** $($s5.Count) hồ sơ`nBạn có thể mở tab **Theo dõi (6 NVKD)** hoặc bấm trực tiếp vào từng bước trên sơ đồ để xử lý."
                suggested_action = "tab_tracker"
            }
        }
        return @{
            reply = "Tôi là **Minh An AI Agent** (hỗ trợ cả 8 bước quy trình). Bạn có thể hỏi tôi:`n- `"Hồ sơ nào đang chờ Trưởng phòng duyệt?`"`n- `"Có đơn nào lỗi ở Bước 5 hoặc Bước 3 không?`"`n- `"Kiểm tra tồn kho 6 Switch Cisco 9200L và 2 Server Dell R750`"`n- Hoặc nhập mã hồ sơ (VD: OPP-2026-001) để tra cứu nhanh."
        }
    }

    # Customer fallback help
    return @{
        reply = "Xin chào! Tôi là **Trợ lý AI Báo giá Minh An**. Tôi giúp Anh/Chị:`n1. Tra cứu giá hiệu lực **$($BaseData.company.active_price_list_version)** & tồn kho thực tế (VD: *`"10 Laptop ThinkPad T14 và 2 Firewall FortiGate 100F`"*).`n2. Kiểm tra thời gian giao hàng khả thi trước khi gửi yêu cầu.`n3. Theo dõi tiến độ hồ sơ (VD: nhập mã OPP-2026-001) và hướng dẫn bổ sung thông tin."
    }
}

function Upsert-Opportunity($Db, $Opp) {
    $list = New-Object System.Collections.ArrayList
    $replaced = $false
    foreach ($item in $Db.opportunities) {
        if ($item.id -eq $Opp.id) {
            [void]$list.Add($Opp)
            $replaced = $true
        } else {
            [void]$list.Add($item)
        }
    }
    if (-not $replaced) {
        $list.Insert(0, $Opp)
    }
    $Db.opportunities = $list.ToArray()
}

function Send-Response($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes) {
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $Bytes.Length
    $Response.Headers.Add("Cache-Control", "no-store")
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Response.OutputStream.Close()
}

function Send-Json($Response, [int]$StatusCode, $Object) {
    $json = $Object | ConvertTo-Json -Depth 12
    $bytes = $Utf8NoBom.GetBytes($json)
    Send-Response $Response $StatusCode "application/json; charset=utf-8" $bytes
}

Ensure-Db
$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  MINH AN B2B SALES AI AGENT - LOCALHOST SERVER RUNNING" -ForegroundColor Green
Write-Host "  URL: $prefix" -ForegroundColor Yellow
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host "==========================================================" -ForegroundColor Cyan

$mimeMap = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".svg"  = "image/svg+xml"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        $path = $req.Url.AbsolutePath

        try {
            if ($req.HttpMethod -eq "GET" -and $path -eq "/api/state") {
                $base = Load-BaseData
                $db = Load-Db
                Send-Json $res 200 @{
                    base = $base
                    opportunities = @($db.opportunities)
                    server_time = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss+07:00")
                }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/process") {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $bodyText = $reader.ReadToEnd()
                $payload = $bodyText | ConvertFrom-Json
                $base = Load-BaseData
                $db = Load-Db
                $opp = Evaluate-Workflow $payload $base $db $null
                Upsert-Opportunity $db $opp
                Save-Db $db
                Send-Json $res 200 @{ ok = $true; opportunity = $opp }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and ($path -eq "/api/clarify" -or $path -eq "/api/negotiate" -or $path -eq "/api/revise")) {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $bodyText = $reader.ReadToEnd()
                $payload = $bodyText | ConvertFrom-Json
                $base = Load-BaseData
                $db = Load-Db
                $existing = $db.opportunities | Where-Object { $_.id -eq $payload.opportunity_id } | Select-Object -First 1
                if ($null -eq $existing) {
                    Send-Json $res 404 @{ ok = $false; error = "Không tìm thấy hồ sơ cơ hội" }
                    continue
                }
                $patch = if ($null -ne $payload.clarification_patch) { $payload.clarification_patch } else { $payload.patch }
                $reprocessPayload = [pscustomobject]@{
                    request_id = $existing.source_request_id
                    channel = $existing.channel
                    customer_company = $existing.customer_company
                    contact_name = $existing.contact_name
                    contact_email = $existing.contact_email
                    raw_content = $existing.raw_content
                    clarification_patch = $patch
                }
                $updated = Evaluate-Workflow $reprocessPayload $base $db $existing
                Upsert-Opportunity $db $updated
                Save-Db $db
                Send-Json $res 200 @{ ok = $true; opportunity = $updated }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/manager-decision") {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $bodyText = $reader.ReadToEnd()
                $payload = $bodyText | ConvertFrom-Json
                $db = Load-Db
                $existing = $db.opportunities | Where-Object { $_.id -eq $payload.opportunity_id } | Select-Object -First 1
                if ($null -eq $existing) {
                    Send-Json $res 404 @{ ok = $false; error = "Không tìm thấy hồ sơ cơ hội" }
                    continue
                }
                $approved = ($payload.decision -eq "APPROVE")
                $existing.status = if ($approved) { "APPROVED_READY_TO_SEND" } else { "REVISION_REQUIRED" }
                $existing.status_label = if ($approved) { "Có thể tiếp tục (Bước 8 - Đã duyệt)" } else { "Từ chối ở Bước 7 - Cần kiểm tra & chỉnh" }
                if ($existing.PSObject.Properties["summary_bucket"]) {
                    $existing.summary_bucket = if ($approved) { "can_continue" } else { "pending_approval" }
                } else {
                    $existing | Add-Member -NotePropertyName "summary_bucket" -NotePropertyValue $(if ($approved) { "can_continue" } else { "pending_approval" })
                }
                $existing.manager_decision = @{
                    decision = $payload.decision
                    note = $payload.note
                    decided_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss+07:00")
                    manager_name = "Trưởng phòng Kinh doanh"
                }
                $existing.updated_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss+07:00")
                foreach ($st in $existing.steps_trail) {
                    if ($st.code -eq "APPROVAL") {
                        $st.status = if ($approved) { "done" } else { "error" }
                        $st.detail = if ($approved) { "Duyệt -> Đi tiếp Bước 8" } else { "Từ chối / Có lỗi cần sửa: $($payload.note)" }
                    }
                    if ($st.code -eq "TRACK") {
                        $st.status = if ($approved) { "active" } else { "pending" }
                        $st.detail = $existing.status_label
                    }
                }
                Upsert-Opportunity $db $existing
                Save-Db $db
                Send-Json $res 200 @{ ok = $true; opportunity = $existing }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/ai-chat") {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $bodyText = $reader.ReadToEnd()
                $payload = $bodyText | ConvertFrom-Json
                $base = Load-BaseData
                $db = Load-Db
                $chatRes = Invoke-AiAssistantChat $payload $base $db
                Send-Json $res 200 $chatRes
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/customer-confirm") {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $bodyText = $reader.ReadToEnd()
                $payload = $bodyText | ConvertFrom-Json
                $db = Load-Db
                $existing = $db.opportunities | Where-Object { $_.id -eq $payload.opportunity_id } | Select-Object -First 1
                if ($null -eq $existing) {
                    Send-Json $res 404 @{ ok = $false; error = "Không tìm thấy hồ sơ cơ hội" }
                    continue
                }
                $existing.status = "CUSTOMER_CONFIRMED"
                $existing.status_label = "Khách hàng đã xác nhận chốt đơn (Bước 8)"
                $existing.updated_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss+07:00")
                foreach ($st in $existing.steps_trail) {
                    if ($st.code -eq "TRACK") {
                        $st.status = "done"
                        $st.detail = "Khách hàng đã xác nhận báo giá & chốt triển khai"
                    }
                }
                Upsert-Opportunity $db $existing
                Save-Db $db
                Send-Json $res 200 @{ ok = $true; opportunity = $existing }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/reset") {
                if (Test-Path $DbFile) { Remove-Item $DbFile -Force }
                Ensure-Db
                Send-Json $res 200 @{ ok = $true }
                continue
            }

            # Static files
            $relPath = if ($path -eq "/") { "index.html" } else { $path.TrimStart('/') }
            $safePath = Join-Path $WebDir ($relPath -replace '/', '\')
            if ((Test-Path $safePath) -and -not (Get-Item $safePath).PSIsContainer) {
                $ext = [System.IO.Path]::GetExtension($safePath).ToLowerInvariant()
                $mime = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { "application/octet-stream" }
                $bytes = [System.IO.File]::ReadAllBytes($safePath)
                Send-Response $res 200 $mime $bytes
            } else {
                $errBytes = $Utf8NoBom.GetBytes("404 Not Found: $path")
                Send-Response $res 404 "text/plain; charset=utf-8" $errBytes
            }
        } catch {
            Write-Host "Error handling $path : $_" -ForegroundColor Red
            Send-Json $res 500 @{ ok = $false; error = $_.Exception.Message }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
