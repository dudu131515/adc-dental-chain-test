# ADC 课程体验部署

体验环境提供一个管理网站和一个微信小程序。两个入口共用 Django `/api/v1` 及同一 PostgreSQL 业务库。部署、体验账号和测试事实使用合成资料。正式资金接口使用已配置的模拟适配器。

## 准备配置

- 把项目放在 Linux 的 `/srv/adc`。在支持的 Python 环境安装 `backend/requirements.txt` 和 Gunicorn，在仓库根目录运行 `npm --prefix web ci` 与 `npm --prefix web run build`。
- 从 [.env.example](.env.example) 建立私有服务环境。设置运行密钥、含账号凭据的数据库 URL、HTTPS 域名和受邀的微信 AppID、应用密钥。经核准的工作日历和耗材成本凭据按 [quickstart.md](../specs/001-adc-system/quickstart.md) 配置。服务管理器以仅服务账号可读的方式提供环境，保持 `ADC_SIMULATION_PAUSED=1` 直至验收所需模拟结果已经核对。
- 把 `adc.conf` 中域名和证书路径改为体验环境的有效值。小程序 `project.config.json` 设置同一受邀 AppID，将 `mini-program/services/environment.js` 的 `EXPERIENCE_API_BASE` 指向该域名的 HTTPS `/api/v1`，在微信后台配置同一合法请求域名。

## 初始化 PostgreSQL

分别创建空业务库和技术库。两库在同一实例，由初始化账号拥有，PostgreSQL 仅对服务内网监听。以初始化账号运行同源建表及验证，再初始化技术库。

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction -d adc_business -f usecase/ADC_PostgreSQL_设计与统计.sql
psql -X -v ON_ERROR_STOP=1 -d adc_business -f usecase/ADC_PostgreSQL_验证.sql
python backend/manage.py migrate --database=runtime
python backend/manage.py createcachetable adc_report_snapshot --database=runtime
```

用 `python backend/scripts/grant_db_access.py --help` 核对授权参数。初始化环境注入两库所有者的连接 URL，为独立运行账号授予脚本定义的最小权限。应用服务只注入运行 URL，完成体验夹具填充及账号哈希配置后执行 `python backend/manage.py check --deploy`。账户的工作范围通过现有授权角色控制。 员工、诊所和牙椅的参考行用于事务串行化。运行账号仅获这三张表的主键列 UPDATE 权限以允许 SELECT FOR UPDATE，业务流程不写入这些主键。运行账号应使用单独创建的角色，由初始化账号执行授权脚本。

## 启动并核对入口

从项目根目录以受限服务账号启动 WSGI，交由服务管理器监控。Nginx 托管已构建的 React 文件，请求继续保持 `/api/v1` 前缀。

```sh
gunicorn --chdir backend --bind 127.0.0.1:8000 config.wsgi:application
nginx -t
```

通过 HTTPS 分别检查管理网站、API 与小程序的登录和登出，并验证登录或列表响应、会话失效、请求头转发及禁止跨店的反例。恢复点的资金核对按 [backup_restore.md](backup_restore.md) 执行。

## 预置总部权限管理员

以受认可的业务库所有者环境，确认目标员工和已有登录账号并登记操作者。将命令中的编号改为部署已登记的编号。

\`\`\`sh
python backend/manage.py configure_adc_scope ADC-EMPLOYEE-NUMBER HQ_ACCESS_ADMIN --actor-account-id 42
\`\`\`

该命令在首次有效授予时注册系统角色，后续可安全重跑。启停普通员工账号和门店授权通过网站办理。总部目录写入需要全连锁目录权限。现有环境升级应由库所有者重跑业务库授权脚本，安装部署专用授权的写入保护。使用受权审计访问复查 audit_log 中 EMPLOYEE_SCOPE_CHANGED 与 EMPLOYEE_ACCOUNT_STATUS_CHANGED，按目标员工 ID 检查时间、操作者与前后值。
