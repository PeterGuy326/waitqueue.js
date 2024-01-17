CREATE SCHEMA waitqueue;
CREATE TABLE IF NOT EXISTS `queue` (
    `id` int(11) NOT NULL AUTO_INCREMENT COMMENT '自增 id',
    `namespace` varchar(36) NOT NULL DEFAULT '' COMMENT '命名空间',
    `url` varchar(255) NOT NULL DEFAULT '' COMMENT '回调事件接口',
    `count` int(11) NOT NULL DEFAULT 0 COMMENT '队列支持的并发数量',
    `run_crontab` varchar(36) NOT NULL DEFAULT '' COMMENT '运行周期规则',
    `check_crontab` varchar(36) NOT NULL DEFAULT '' COMMENT '检查周期规则',
    `expire_crontab` varchar(36) NOT NULL DEFAULT '' COMMENT '过期周期规则',
    `created_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `updated_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '任务队列表'