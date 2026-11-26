# ADC 课程体验部署

体验环境提供一个管理网站和一个微信小程序。两个入口共用 Django `/api/v1` 及同一 PostgreSQL 业务库。部署、体验账号和测试事实使用合成资料。正式资金接口使用已配置的模拟适配器。

## 准备配置

- 把项目放在 Linux 的 `/srv/adc`。在支持的 Python 环境安装 `backend/requirements.txt` 和 Gunicorn，在仓库根目录运行 `npm --prefix web ci` 与 `npm --prefix web run build`。
- 从 [.env.example](.env.example) 建立私有服务环境。设置运行密钥、含账号凭据的数据库 URL、HTTPS 域名和受邀的微信 AppID、应用密钥。经核准的工作日历和耗材成本凭据按 [quickstart.md](../specs/001-adc-system/quickstart.md) 配置。服务管理器以仅服务账号可读的方式提供环境，保持 `ADC_SIMULATION_PAUSED=1` 直至验收所需模拟结果已经核对。
- 把 `adc.conf` 中域名和证书路径改为体验环境的有效值。小程序 `project.config.json` 设置同一受邀 AppID，将 `mini-program/services/environment.js` 的 `EXPERIENCE_API_BASE` 指向该域名的 HTTPS `/api/v1`，在微信后台配置同一合法请求域名。

## 初始化 PostgreSQL

分别创建空业务库和技术库。两库在同一实例，由初始化账号拥有，PostgreSQL 仅对服务内网监听。以初始化账号运行同源建表及验证，再初始化技术库。

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction -d adc_business -f usecase/ADC_PostgreSQL_设计与统计.sql -f backend/scripts/master_data_access.sql
psql -X -v ON_ERROR_STOP=1 -d adc_business -f usecase/ADC_PostgreSQL_验证.sql
python backend/manage.py migrate --database=runtime
python backend/manage.py createcachetable adc_report_snapshot --database=runtime
```

用 `python backend/scripts/grant_db_access.py --help` 核对授权参数。初始化环境注入两库所有者的连接 URL，为独立运行账号授予脚本定义的最小权限。应用服务只注入运行 URL，完成体验夹具填充及账号哈希配置后执行 `python backend/manage.py check --deploy`。账户的工作范围通过现有授权角色控制。 员工、诊所和牙椅的参考行用于事务串行化。运行账号可锁定这三张表的参考行。员工表只额外开放岗位和所属门店两列的更新权限，由管理接口检查管理员权限并记录审计。运行账号应使用单独创建的角色，由初始化账号执行授权脚本。

### 已有业务库升级员工档案

先在计划的发布窗口备份业务库。由数据库所有者执行：

```sh
pg_dump -Fc -d adc_business -f adc_business_before_employee_profiles.dump
psql -X -v ON_ERROR_STOP=1 --single-transaction -d adc_business -f backend/scripts/upgrade_employee_profiles.sql
```

随后重新运行本节的业务库授权脚本，再部署新的 Django 和 React。旧员工先保留为空，由管理员到「员工与权限」按已核实的资料补录。所属门店与授权门店分别保留，升级不改现有授权、员工账号和业务记录。若需要回退，恢复上一个应用版本即可，新增资料列可留在库中供再次升级时使用。若必须恢复旧库结构，先在独立数据库还原备份并核对发布后的新增业务数据，再安排切换。

### 已有业务库升级基础资料

在发布窗口备份业务库。若尚未安装员工档案升级，先执行上一节。随后以数据库所有者运行以下命令。

```sh
pg_dump -Fc -d adc_business -f adc_business_before_master_data.dump
psql -X -v ON_ERROR_STOP=1 --single-transaction -d adc_business -f backend/scripts/upgrade_master_data.sql
```

重新运行数据库授权脚本后部署 Django 和 React。运行账号通过受限数据库函数完成基础资料写入。迁移保留原业务记录，补齐既有耗材使用的名称与单位快照。原部署账号继续使用既有哈希配置，新开通账号使用数据库中的密码哈希。耗材按实际就诊日读取数据库成本版本，未配置该日期时沿用原成本配置。回退时先切回上一版应用并保留新增列、版本及账号资料。若要还原原库，先把备份恢复到独立数据库，核对发布后的业务记录及新增本地账号，再切换连接。

## 启动并核对入口

从项目根目录以受限服务账号启动 WSGI，交由服务管理器监控。Nginx 托管已构建的 React 文件，请求继续保持 `/api/v1` 前缀。

```sh
gunicorn --chdir backend --bind 127.0.0.1:8000 config.wsgi:application
nginx -t
```

通过 HTTPS 分别检查管理网站、API 与小程序的登录和登出，并验证登录或列表响应、会话失效、请求头转发及禁止跨店的反例。恢复点的资金核对按 [backup_restore.md](backup_restore.md) 执行。

## 配置 DeepSeek 经营助手

GitHub Pages 从前端内置的合成对话和样例报表生成演示结果。员工网站登录后按当前账号的门店权限查询 Django 报表。Django 在本地解析提问，并把允许的指标、日期、门店代号、合成汇总及相关条款提交给模型。自由输入原文、患者档案、病历、过敏记录、业务明细和原报表凭证留在第三方请求之外。Django 用已批准的观察和来源生成展示内容。

### Linux 体验服务

为现有 Django 服务建立独立的私有环境文件，例如由 root 持有、权限为 0600 的 /etc/adc/assistant.env。用服务管理器的 EnvironmentFile 指向此路径。已有的服务环境仍提供数据库等应用变量。将下列同名配置放入该私有文件，主机、端口和库名需与 ADC_BUSINESS_DB_URL 指向的专用合成业务库一致。只让 Django 服务进程收到密钥。

```dotenv
ADC_ASSISTANT_DEEPSEEK_ENABLED=1
ADC_ASSISTANT_SYNTHETIC_ENV=experience
ADC_ASSISTANT_SYNTHETIC_HOST=postgres.internal
ADC_ASSISTANT_SYNTHETIC_PORT=5432
ADC_ASSISTANT_SYNTHETIC_DB=adc_synthetic_business
ADC_DEEPSEEK_MODEL=deepseek-flash
ADC_DEEPSEEK_API_KEY=
```

在私有环境文件内填写新密钥。公开的 .env.example 提供空值供参考。替换密钥时更新私有文件，然后重启 Django 进程。对话流程通过模型供应商的状态和权限边界验收，正式患者数据库继续使用服务器的报表解读。

### Windows 本地体验

建立专用合成库后，在启动 Django 的同一个 PowerShell 窗口输入下面的命令。密钥在终端内遮挡输入，保存在当前进程环境中。

```powershell
$adcDatabase = [Uri]$env:ADC_BUSINESS_DB_URL
$env:ADC_ASSISTANT_DEEPSEEK_ENABLED = '1'
$env:ADC_ASSISTANT_SYNTHETIC_ENV = $env:ADC_ENV
$env:ADC_ASSISTANT_SYNTHETIC_HOST = $adcDatabase.Host
$env:ADC_ASSISTANT_SYNTHETIC_PORT = if ($adcDatabase.Port -gt 0) { [string]$adcDatabase.Port } else { '5432' }
$env:ADC_ASSISTANT_SYNTHETIC_DB = [Uri]::UnescapeDataString($adcDatabase.AbsolutePath.TrimStart('/'))
$adcMaskedKey = Read-Host '在此输入专用合成环境的 DeepSeek 密钥' -AsSecureString
$env:ADC_DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $adcMaskedKey).Password
Remove-Variable adcMaskedKey
```

启动 Django 后用经营查询样例账号打开「经营与配置 → 经营智能助手」。提交双店实际就诊率问题并打开原报表。接口的 mode 为 deepseek、model_status 为 completed 时，表示实际模型调用完成。缺少配置、目标合成库不匹配或模型不可用时，页面仍能使用内置报表解读。结束本地联调后关闭该终端，或执行 Remove-Item Env:ADC_DEEPSEEK_API_KEY 清理当前窗口的密钥。

## 预置总部权限管理员

以受认可的业务库所有者环境，确认目标员工和已有登录账号并登记操作者。将命令中的编号改为部署已登记的编号。

\`\`\`sh
python backend/manage.py configure_adc_scope ADC-EMPLOYEE-NUMBER HQ_ACCESS_ADMIN --actor-account-id 42
\`\`\`

该命令在首次有效授予时注册系统角色，后续可安全重跑。启停普通员工账号和门店授权通过网站办理。总部目录写入需要全连锁目录权限。现有环境升级应由库所有者重跑业务库授权脚本，安装部署专用授权的写入保护。使用受权审计访问复查 audit_log 中 EMPLOYEE_SCOPE_CHANGED 与 EMPLOYEE_ACCOUNT_STATUS_CHANGED，按目标员工 ID 检查时间、操作者与前后值。
