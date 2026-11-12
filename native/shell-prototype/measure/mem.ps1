# mem.ps1 -RootPid <pid>: working set and private bytes summed over the process tree under RootPid (WebView2 and CEF
# helpers are children of the shell's process), one JSON object.
param([int]$RootPid, [string]$Name = "")
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$tree = @($RootPid); $frontier = @($RootPid)
while ($frontier.Count -gt 0) {
  $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
  $next = @($next | Where-Object { $tree -notcontains $_ })
  $tree += $next; $frontier = $next
}
$procs = @(Get-Process -Id $tree -ErrorAction SilentlyContinue | Where-Object { -not $Name -or $_.ProcessName -eq $Name })
$perf = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
[pscustomobject]@{
  processes = $procs.Count
  workingSetMB = [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum) / 1MB, 1)
  privateWorkingSetMB = [math]::Round((($procs | ForEach-Object { $perf[$_.Id] } | Measure-Object -Sum).Sum) / 1MB, 1)
  privateBytesMB = [math]::Round((($procs | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB, 1)
  names = (($procs | Group-Object ProcessName | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ',')
} | ConvertTo-Json -Compress
