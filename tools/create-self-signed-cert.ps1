param(
  [string]$OutputPath = (Join-Path $env:LOCALAPPDATA 'ClimaGrid\climagrid-dev.pfx'),
  [System.Security.SecureString]$Password
)

$ErrorActionPreference = 'Stop'
if (-not $Password) {
  $Password = Read-Host 'PFX password' -AsSecureString
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $OutputPath))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
}

$certificate = New-SelfSignedCertificate `
  -DnsName 'localhost', '127.0.0.1' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(1) `
  -FriendlyName 'ClimaGrid local development TLS'
try {
  Export-PfxCertificate -Cert $certificate -FilePath $OutputPath -Password $Password | Out-Null
  Write-Output "Self-signed certificate exported to $OutputPath"
  Write-Output "Set HTTPS_PFX to this path and HTTPS_PFX_PASSWORD to the entered password."
} finally {
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force
}
