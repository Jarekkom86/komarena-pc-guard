param(
  [ValidateSet("status", "quick", "deep")]
  [string] $Mode = "quick"
)

$ErrorActionPreference = "Stop"

function Invoke-Safely {
  param(
    [scriptblock] $Block,
    [object] $Fallback = $null
  )

  try {
    & $Block
  }
  catch {
    if ($null -ne $Fallback) {
      return $Fallback
    }

    return [ordered]@{
      available = $false
      error = $_.Exception.Message
    }
  }
}

function Convert-BytesToGb {
  param([Nullable[double]] $Value)
  if ($null -eq $Value) { return $null }
  return [Math]::Round(([double] $Value) / 1GB, 2)
}

function Convert-BytesToMb {
  param([Nullable[double]] $Value)
  if ($null -eq $Value) { return $null }
  return [Math]::Round(([double] $Value) / 1MB, 1)
}

function Get-Percent {
  param(
    [Nullable[double]] $Used,
    [Nullable[double]] $Total
  )

  if ($null -eq $Used -or $null -eq $Total -or [double] $Total -le 0) {
    return $null
  }

  return [Math]::Round((([double] $Used / [double] $Total) * 100), 1)
}

function Add-Recommendation {
  param(
    [System.Collections.Generic.List[object]] $List,
    [string] $Severity,
    [string] $Title,
    [string] $Detail
  )

  $List.Add([ordered]@{
    severity = $Severity
    title = $Title
    detail = $Detail
  }) | Out-Null
}

function Get-Thermals {
  $zones = @(Invoke-Safely {
    Get-CimInstance -Namespace "root/wmi" -ClassName "MSAcpi_ThermalZoneTemperature" -ErrorAction Stop |
      ForEach-Object {
        $celsius = [Math]::Round((([double] $_.CurrentTemperature - 2732) / 10), 1)
        if ($celsius -gt -40 -and $celsius -lt 130) {
          [ordered]@{
            name = if ($_.InstanceName) { [string] $_.InstanceName } else { "Thermal zone" }
            celsius = $celsius
            source = "MSAcpi_ThermalZoneTemperature"
          }
        }
      }
  } @())

  return [ordered]@{
    available = $zones.Count -gt 0
    sensors = $zones
    note = if ($zones.Count -gt 0) {
      "Windows poskytol teploty cez ACPI thermal zones."
    } else {
      "Windows casto neposkytuje CPU/GPU teploty bez ovladaca alebo vendor API. Modul je pripraveny, senzor sa zobrazi, ked ho system spristupni."
    }
  }
}

function Get-DefenderStatus {
  $status = Invoke-Safely {
    Get-MpComputerStatus -ErrorAction Stop
  }

  if ($status -is [System.Collections.IDictionary] -and $status.available -eq $false) {
    return [ordered]@{
      available = $false
      message = $status.error
      threats = @()
    }
  }

  $threats = @(Invoke-Safely {
    Get-MpThreat -ErrorAction Stop |
      Select-Object -First 25 ThreatName, SeverityID, CategoryID, DidThreatExecute, IsActive, Resources
  } @())

  return [ordered]@{
    available = $true
    antivirusEnabled = [bool] $status.AntivirusEnabled
    realTimeProtectionEnabled = [bool] $status.RealTimeProtectionEnabled
    behaviorMonitorEnabled = [bool] $status.BehaviorMonitorEnabled
    ioavProtectionEnabled = [bool] $status.IoavProtectionEnabled
    antispywareEnabled = [bool] $status.AntispywareEnabled
    signaturesAgeDays = [int] $status.AntivirusSignatureAge
    quickScanAgeDays = [int] $status.QuickScanAge
    fullScanAgeDays = [int] $status.FullScanAge
    lastQuickScan = if ($status.QuickScanEndTime) { ([datetime] $status.QuickScanEndTime).ToString("o") } else { $null }
    lastFullScan = if ($status.FullScanEndTime) { ([datetime] $status.FullScanEndTime).ToString("o") } else { $null }
    threats = $threats
  }
}

function Get-FirewallStatus {
  return @(Invoke-Safely {
    Get-NetFirewallProfile -ErrorAction Stop |
      Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction
  } @())
}

function Get-StorageStatus {
  $logical = @(Invoke-Safely {
    Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop |
      ForEach-Object {
        $used = [double] $_.Size - [double] $_.FreeSpace
        [ordered]@{
          name = [string] $_.DeviceID
          label = [string] $_.VolumeName
          fileSystem = [string] $_.FileSystem
          sizeGb = Convert-BytesToGb $_.Size
          freeGb = Convert-BytesToGb $_.FreeSpace
          usedPercent = Get-Percent $used $_.Size
        }
      }
  } @())

  $physical = @(Invoke-Safely {
    Get-PhysicalDisk -ErrorAction Stop |
      Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus, Size
  } @())

  return [ordered]@{
    logical = $logical
    physical = @($physical | ForEach-Object {
      [ordered]@{
        name = [string] $_.FriendlyName
        mediaType = [string] $_.MediaType
        health = [string] $_.HealthStatus
        status = [string] (@($_.OperationalStatus) -join ", ")
        sizeGb = Convert-BytesToGb $_.Size
      }
    })
  }
}

function Get-ConnectedDevices {
  $classes = @("USB", "HIDClass", "Keyboard", "Mouse", "DiskDrive", "Net", "Bluetooth", "MEDIA", "Monitor", "Image", "Camera")

  return @(Invoke-Safely {
    Get-PnpDevice -PresentOnly -ErrorAction Stop |
      Where-Object { $classes -contains $_.Class } |
      Sort-Object Class, FriendlyName |
      Select-Object -First 120 |
      ForEach-Object {
        [ordered]@{
          name = [string] $_.FriendlyName
          class = [string] $_.Class
          status = [string] $_.Status
          instanceId = [string] $_.InstanceId
        }
      }
  } @())
}

function Get-NetworkStatus {
  return @(Invoke-Safely {
    Get-NetAdapter -ErrorAction Stop |
      Sort-Object Status, Name |
      ForEach-Object {
        [ordered]@{
          name = [string] $_.Name
          description = [string] $_.InterfaceDescription
          status = [string] $_.Status
          macAddress = [string] $_.MacAddress
          linkSpeed = [string] $_.LinkSpeed
        }
      }
  } @())
}

function Get-StartupItems {
  $items = New-Object System.Collections.Generic.List[object]
  $registryPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"
  )

  foreach ($path in $registryPaths) {
    $props = Invoke-Safely { Get-ItemProperty -LiteralPath $path -ErrorAction Stop } $null
    if ($null -eq $props) { continue }

    foreach ($prop in $props.PSObject.Properties) {
      if ($prop.Name -like "PS*") { continue }
      $items.Add([ordered]@{
        name = [string] $prop.Name
        command = [string] $prop.Value
        source = $path
      }) | Out-Null
    }
  }

  $startupFolders = @(
    [Environment]::GetFolderPath("Startup"),
    [Environment]::GetFolderPath("CommonStartup")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($folder in $startupFolders) {
    Get-ChildItem -LiteralPath $folder -Force -ErrorAction SilentlyContinue |
      Select-Object -First 60 |
      ForEach-Object {
        $items.Add([ordered]@{
          name = $_.Name
          command = $_.FullName
          source = $folder
        }) | Out-Null
      }
  }

  return @($items | Select-Object -First 140)
}

function Get-ProcessSignals {
  $watchNames = @(
    "powershell.exe", "pwsh.exe", "cmd.exe", "wscript.exe", "cscript.exe", "mshta.exe",
    "rundll32.exe", "regsvr32.exe", "certutil.exe", "bitsadmin.exe", "schtasks.exe"
  )

  $rows = @(Invoke-Safely {
    Get-CimInstance Win32_Process -ErrorAction Stop |
      ForEach-Object {
        $name = ([string] $_.Name).ToLowerInvariant()
        $path = [string] $_.ExecutablePath
        $command = [string] $_.CommandLine
        $signals = New-Object System.Collections.Generic.List[string]
        $isOwnAudit = $command -match "(?i)komarena-pc-audit\.ps1"

        if (!$isOwnAudit -and $command -match "(?i)(\s-enc(odedcommand)?\s|frombase64string|downloadstring|invoke-webrequest|iex\s|executionpolicy\s+bypass|\s-ep\s+bypass|windowstyle\s+hidden)") {
          $signals.Add("suspicious_command_line") | Out-Null
        }
        if ($path -match "(?i)\\AppData\\Local\\Temp\\|\\Downloads\\|\\Temp\\|\\`$Recycle\.Bin\\") {
          $signals.Add("unusual_launch_location") | Out-Null
        }
        if (!$isOwnAudit -and $watchNames -contains $name -and $command.Length -gt 140) {
          $signals.Add("living_off_the_land_tool") | Out-Null
        }
        if ($path -eq "" -and $watchNames -contains $name) {
          $signals.Add("missing_executable_path") | Out-Null
        }

        if ($signals.Count -gt 0) {
          [ordered]@{
            pid = [int] $_.ProcessId
            parentPid = [int] $_.ParentProcessId
            name = [string] $_.Name
            path = $path
            commandLine = if ($command.Length -gt 360) { $command.Substring(0, 360) + "..." } else { $command }
            signals = @($signals)
            score = [Math]::Min(100, 25 * $signals.Count)
          }
        }
      }
  } @())

  return @($rows | Sort-Object score -Descending | Select-Object -First 40)
}

function Get-TopProcesses {
  return @(Invoke-Safely {
    Get-Process -ErrorAction Stop |
      Sort-Object WorkingSet64 -Descending |
      Select-Object -First 15 |
      ForEach-Object {
        [ordered]@{
          name = [string] $_.ProcessName
          pid = [int] $_.Id
          memoryMb = Convert-BytesToMb $_.WorkingSet64
          cpuSeconds = if ($null -ne $_.CPU) { [Math]::Round([double] $_.CPU, 1) } else { $null }
        }
      }
  } @())
}

function Get-InstalledAppsSummary {
  if ($Mode -ne "deep") {
    return [ordered]@{
      mode = "summary"
      note = "Zoznam instalovanych aplikacii sa cita v deep rezime."
      recent = @()
    }
  }

  $paths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  $apps = @()
  foreach ($path in $paths) {
    $apps += @(Invoke-Safely {
      Get-ItemProperty -Path $path -ErrorAction Stop |
        Where-Object { $_.DisplayName } |
        ForEach-Object {
          [ordered]@{
            name = [string] $_.DisplayName
            version = [string] $_.DisplayVersion
            publisher = [string] $_.Publisher
            installDate = [string] $_.InstallDate
          }
        }
    } @())
  }

  return [ordered]@{
    mode = "deep"
    count = @($apps).Count
    recent = @($apps | Sort-Object installDate -Descending | Select-Object -First 40)
  }
}

$recommendations = New-Object System.Collections.Generic.List[object]

$computer = Invoke-Safely { Get-CimInstance Win32_ComputerSystem -ErrorAction Stop }
$os = Invoke-Safely { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
$cpu = Invoke-Safely { Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 }
$cpuLoad = Invoke-Safely { (Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average } 0

$totalMemory = if ($computer.TotalPhysicalMemory) { [double] $computer.TotalPhysicalMemory } else { [double] $os.TotalVisibleMemorySize * 1KB }
$freeMemory = [double] $os.FreePhysicalMemory * 1KB
$usedMemory = $totalMemory - $freeMemory
$memoryUsedPercent = Get-Percent $usedMemory $totalMemory

$storage = Get-StorageStatus
$thermals = Get-Thermals
$defender = Get-DefenderStatus
$firewall = Get-FirewallStatus
$devices = Get-ConnectedDevices
$network = Get-NetworkStatus
$startup = Get-StartupItems
$signals = Get-ProcessSignals
$topProcesses = Get-TopProcesses
$apps = Get-InstalledAppsSummary

$score = 100

if ($defender.available -eq $false) {
  $score -= 15
  Add-Recommendation $recommendations "medium" "Windows Defender sa nepodarilo nacitat" "Antivirus vrstva potrebuje dostupne Defender cmdlety alebo doplnkovy engine."
}
else {
  if (!$defender.antivirusEnabled) {
    $score -= 35
    Add-Recommendation $recommendations "high" "Antivirus je vypnuty" "Zapni Microsoft Defender alebo iny overeny antivirus."
  }
  if (!$defender.realTimeProtectionEnabled) {
    $score -= 30
    Add-Recommendation $recommendations "high" "Real-time ochrana je vypnuta" "Zapni real-time ochranu, inak agent vidi problem az po incidente."
  }
  if ($defender.signaturesAgeDays -gt 7) {
    $score -= 12
    Add-Recommendation $recommendations "medium" "Antivirus podpisy su starsie ako 7 dni" "Spusti aktualizaciu bezpecnostnych definicii."
  }
  if (@($defender.threats).Count -gt 0) {
    $score -= 30
    Add-Recommendation $recommendations "critical" "Defender eviduje hrozby" "Skontroluj detekcie a spusti cistenie cez Windows Security."
  }
}

$disabledFirewall = @($firewall | Where-Object { $_.Enabled -eq $false })
if ($disabledFirewall.Count -gt 0) {
  $score -= [Math]::Min(20, 8 * $disabledFirewall.Count)
  Add-Recommendation $recommendations "medium" "Niektore firewall profily su vypnute" "Zapni firewall pre vsetky profily, hlavne Public."
}

foreach ($disk in $storage.logical) {
  if ($null -ne $disk.usedPercent -and $disk.usedPercent -gt 90) {
    $score -= 10
    Add-Recommendation $recommendations "medium" "Disk $($disk.name) je skoro plny" "Volne miesto: $($disk.freeGb) GB. Plny disk zhorsuje aktualizacie, skeny a stabilitu."
  }
}

foreach ($sensor in $thermals.sensors) {
  if ($sensor.celsius -ge 85) {
    $score -= 15
    Add-Recommendation $recommendations "high" "Vysoka teplota: $($sensor.celsius) C" "Skontroluj chladenie, prach, ventilatory a zataz."
  }
}

if ($memoryUsedPercent -gt 90) {
  $score -= 10
  Add-Recommendation $recommendations "medium" "RAM je vytazena nad 90 percent" "Pozri top procesy a zvaz restart alebo optimalizaciu aplikacii."
}

if ([double] $cpuLoad -gt 90) {
  $score -= 8
  Add-Recommendation $recommendations "medium" "CPU je vytazene nad 90 percent" "Pozri top procesy a spusti opakovany scan po par minutach."
}

if (@($signals).Count -gt 0) {
  $score -= [Math]::Min(30, 8 * @($signals).Count)
  Add-Recommendation $recommendations "high" "Nasli sa procesy s rizikovymi signalmi" "Skontroluj procesy so signalmi a over, ci ide o legitimne nastroje."
}

$score = [Math]::Max(0, [Math]::Min(100, [int] $score))
$level = if ($score -ge 85) { "good" } elseif ($score -ge 70) { "watch" } elseif ($score -ge 50) { "risk" } else { "critical" }
$lastBoot = $os.LastBootUpTime
if ($lastBoot -is [datetime]) {
  $lastBootDate = $lastBoot
}
elseif ($lastBoot) {
  $lastBootDate = [Management.ManagementDateTimeConverter]::ToDateTime([string] $lastBoot)
}
else {
  $lastBootDate = Get-Date
}
$uptimeHours = [Math]::Round(((Get-Date) - $lastBootDate).TotalHours, 1)
$cpuLoadPercent = [Math]::Round(([double] $cpuLoad), 1)
$memoryTotalGb = Convert-BytesToGb $totalMemory
$memoryUsedGb = Convert-BytesToGb $usedMemory
$deviceCount = @($devices).Count
$generatedAt = (Get-Date).ToString("o")
$recommendationItems = @($recommendations.ToArray())
$topProcessItems = @($topProcesses)
$deviceItems = @($devices)
$firewallItems = @($firewall)
$signalItems = @($signals)
$startupItems = @($startup)

$result = [ordered]@{
  ok = $true
  product = "Komarena.sk PC Guard"
  mode = $Mode
  generatedAt = $generatedAt
  score = [ordered]@{
    value = $score
    level = $level
    recommendations = $recommendationItems
  }
  computer = [ordered]@{
    name = [string] $env:COMPUTERNAME
    user = [string] $env:USERNAME
    manufacturer = [string] $computer.Manufacturer
    model = [string] $computer.Model
    os = [string] $os.Caption
    osVersion = [string] $os.Version
    uptimeHours = $uptimeHours
  }
  modules = [ordered]@{
    performance = [ordered]@{
      cpuName = [string] $cpu.Name
      cpuLoadPercent = $cpuLoadPercent
      memoryTotalGb = $memoryTotalGb
      memoryUsedGb = $memoryUsedGb
      memoryUsedPercent = $memoryUsedPercent
      topProcesses = $topProcessItems
    }
    thermals = $thermals
    storage = $storage
    devices = [ordered]@{
      count = $deviceCount
      items = $deviceItems
    }
    network = [ordered]@{
      adapters = $network
    }
    security = [ordered]@{
      defender = $defender
      firewall = $firewallItems
      suspiciousProcesses = $signalItems
    }
    software = [ordered]@{
      startupItems = $startupItems
      installedApps = $apps
    }
  }
}

$result | ConvertTo-Json -Depth 12
