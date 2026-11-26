[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z][a-z0-9_]{0,62}$')]
    [string] $BusinessDatabase,
    [switch] $Verify
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$inputDirectory = Join-Path $projectRoot 'usecase'
$design = Join-Path $inputDirectory 'ADC_PostgreSQL_设计与统计.sql'
$verification = Join-Path $inputDirectory 'ADC_PostgreSQL_验证.sql'
$masterData = Join-Path $PSScriptRoot 'master_data_access.sql'

# PGHOST, PGPORT and PGUSER must address the intended initializer role and instance.
# Provide credentials through a PostgreSQL service/passfile rather than the command line.
& psql -X -v ON_ERROR_STOP=1 --single-transaction -d $BusinessDatabase -f $design -f $masterData
if ($LASTEXITCODE -ne 0) { throw 'ADC business schema initialization failed.' }

if ($Verify) {
    & psql -X -v ON_ERROR_STOP=1 -d $BusinessDatabase -f $verification
    if ($LASTEXITCODE -ne 0) { throw 'ADC schema verification failed.' }
    & psql -X -v ON_ERROR_STOP=1 -d $BusinessDatabase -tAc 'SELECT count(*) FROM appointment'
    if ($LASTEXITCODE -ne 0) { throw 'ADC rollback verification failed.' }
}
