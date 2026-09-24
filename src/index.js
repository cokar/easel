// Worker 入口：所有请求先进这里，再由 Host 决定去向。
//
//   <根域名> / localhost / 预览域名                   -> 对外入口页（项目列表 + 后台入口）
//   admin.<域名>                                       -> 管理后台界面 + /api/*
//   <项目>.域名                                        -> 该项目在 R2 里的静态文件
//   www.<域名>                                         -> 302 到根域名
//   其他保留子域名                                      -> 提示页
//
// 需要两条路由：*.<域名>/* 覆盖后台和所有项目，<域名>/* 让根域名到达入口页。
// 通配路由不匹配根域名本身，两条都要，见 scripts/build-config.mjs。

import { parseHost } from './util.js';
import { handleApi } from './api.js';
import { serveProject, serveAdmin, infoPage } from './serve.js';
import { serveLanding } from './landing.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = parseHost(url.hostname, env.ROOT_DOMAIN, env.ADMIN_SUBDOMAIN || 'admin');

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, host);
    }

    switch (host.kind) {
      case 'project':
        return serveProject(request, env, ctx, host.projectId);

      // 根域名是给访客看的入口页；本地开发的 127.0.0.1 / localhost 也走它，
      // 后台在本地用 admin.localhost 访问。
      case 'apex':
      case 'local':
        return serveLanding(request, env, ctx);

      // workers.dev 预览域名等不认识的 Host 直接给后台，方便域名还没接好时先管起来
      case 'admin':
      case 'unknown':
        return serveAdmin(request, env);

      case 'www':
        return Response.redirect(`https://${env.ROOT_DOMAIN}/`, 302);

      case 'reserved':
        return infoPage(
          404,
          '保留子域名',
          `<code>${host.label}</code> 是系统保留名，未被分配给任何项目。`,
          env
        );

      case 'invalid':
        return infoPage(
          404,
          '地址无效',
          '只能通过 <code>项目名.' + String(env.ROOT_DOMAIN || '') + '</code> 这一层子域名访问（免费版证书不覆盖多级子域名）。',
          env
        );

      default:
        return infoPage(404, '未找到', '这个地址没有对应的内容。', env);
    }
  },
};
