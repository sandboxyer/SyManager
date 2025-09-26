import C from '../../C.js'

let Monitor = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <pwd.h>
#include <utmpx.h>
#include <syslog.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <sys/file.h>

#define MAX_EVENTS 1024
#define EVENT_SIZE (sizeof(struct inotify_event))
#define BUF_LEN (MAX_EVENTS * (EVENT_SIZE + 16))
#define LOG_FILE "/var/log/system_monitor.log"
#define CONFIG_FILE "/etc/system_monitor.conf"
#define STATS_FILE "/tmp/system_monitor_stats"
#define CONFIG_CHECK_INTERVAL 5

typedef enum {
    EVENT_LOGIN,
    EVENT_LOGOUT,
    EVENT_SSH,
    EVENT_FILE_MOVE,
    EVENT_FILE_EDIT,
    EVENT_FILE_CREATE,
    EVENT_FILE_DELETE,
    EVENT_NETWORK,
    EVENT_PROCESS,
    EVENT_OTHERS,
    EVENT_COUNT
} event_type_t;

typedef struct {
    event_type_t type;
    int enabled;
} event_filter_t;

typedef struct {
    char username[32];
    char source[64];
    char details[256];
    event_type_t type;
    time_t timestamp;
} system_event_t;

typedef struct {
    int events_second[EVENT_COUNT];
    int events_minute[EVENT_COUNT];
    int total_events;
    time_t last_update;
} stats_t;

// Global variables
event_filter_t filters[EVENT_COUNT];
stats_t stats;
int running = 1;
int log_fd = -1;
time_t last_config_check = 0;
time_t program_start_time;
time_t last_stats_update = 0;
char self_identifier[256] = {0};
pid_t self_pid;

const char* event_type_names[] = {
    "LOGIN", "LOGOUT", "SSH", "FILE_MOVE", "FILE_EDIT", 
    "FILE_CREATE", "FILE_DELETE", "NETWORK", "PROCESS", "OTHERS"
};

void load_self_identifier() {
    self_pid = getpid();
    
    // Get the full command line to identify our process
    FILE *cmdline = fopen("/proc/self/cmdline", "r");
    if (cmdline) {
        char full_cmd[1024];
        if (fread(full_cmd, 1, sizeof(full_cmd) - 1, cmdline) > 0) {
            // Replace null bytes with spaces for easier searching
            for (int i = 0; i < sizeof(full_cmd) && full_cmd[i] != 0; i++) {
                if (full_cmd[i] == 0) full_cmd[i] = ' ';
            }
            strncpy(self_identifier, full_cmd, sizeof(self_identifier) - 1);
        }
        fclose(cmdline);
    }
    
    printf("Self-identifier loaded (PID: %d)\\n", self_pid);
}

int is_self_event(const system_event_t *event) {
    // Always ignore events related to our specific files
    if (strstr(event->details, "system_monitor.log") != NULL) return 1;
    if (strstr(event->details, "system_monitor_stats") != NULL) return 1;
    if (strstr(event->details, "system_monitor.conf") != NULL) return 1;
    if (strstr(event->source, "system_monitor") != NULL) return 1;
    
    // Ignore events from monitor_config
    if (strstr(event->details, "monitor_config") != NULL) return 1;
    if (strstr(event->source, "monitor_config") != NULL) return 1;
    
    // Ignore events that mention our process name
    if (strstr(event->details, "monitor") != NULL) return 1;
    
    // For file events, check if they're in directories we're monitoring but caused by us
    if (strstr(event->source, "FILE_SYSTEM") != NULL) {
        // If the event is from a file we're definitely writing to, ignore it
        if (strstr(event->details, LOG_FILE) != NULL) return 1;
        if (strstr(event->details, STATS_FILE) != NULL) return 1;
        if (strstr(event->details, CONFIG_FILE) != NULL) return 1;
    }
    
    // Check if the event is from the current user and might be related to our processes
    struct passwd *pw = getpwuid(getuid());
    if (pw && strcmp(event->username, pw->pw_name) == 0) {
        // If we're monitoring processes and this is about process count changes that include us, ignore
        if (event->type == EVENT_PROCESS) {
            // Process events are usually fine, but if they mention our specific process, ignore
            if (strstr(event->details, "monitor") != NULL) return 1;
        }
    }
    
    return 0;
}

void update_stats(event_type_t type) {
    time_t now = time(NULL);
    
    // Reset stats every minute
    if (now - stats.last_update >= 60) {
        memset(stats.events_minute, 0, sizeof(stats.events_minute));
        stats.last_update = now;
    }
    
    // Reset per-second counts every second
    if (now != last_stats_update) {
        memset(stats.events_second, 0, sizeof(stats.events_second));
        last_stats_update = now;
    }
    
    stats.events_second[type]++;
    stats.events_minute[type]++;
    stats.total_events++;
    
    // Save stats to file for the config interface
    FILE *stats_file = fopen(STATS_FILE, "w");
    if (stats_file) {
        fwrite(&stats, sizeof(stats), 1, stats_file);
        fclose(stats_file);
    }
}

void log_event(const system_event_t *event) {
    // Check if this is a self-event BEFORE any processing
    if (is_self_event(event)) {
        return; // Completely ignore self-events
    }
    
    char timestamp[64];
    struct tm *tm_info;
    
    tm_info = localtime(&event->timestamp);
    strftime(timestamp, sizeof(timestamp), "%d/%m/%Y %H:%M:%S", tm_info);
    
    char log_entry[512];
    snprintf(log_entry, sizeof(log_entry),
             "[%s] Type: %s, User: %s, Source: %s, Details: %s\\n",
             timestamp, event_type_names[event->type], 
             event->username, event->source, event->details);
    
    if (log_fd != -1) {
        write(log_fd, log_entry, strlen(log_entry));
        fsync(log_fd);
    }
    
    printf("%s", log_entry);
    fflush(stdout);
    
    update_stats(event->type);
}

void load_config() {
    int config_fd = open(CONFIG_FILE, O_RDONLY);
    if (config_fd == -1) {
        return;
    }
    
    if (flock(config_fd, LOCK_SH) == -1) {
        close(config_fd);
        return;
    }
    
    FILE *config = fdopen(config_fd, "r");
    if (!config) {
        close(config_fd);
        return;
    }
    
    char line[256];
    while (fgets(line, sizeof(line), config)) {
        if (line[0] == '#' || line[0] == '\\n') continue;
        
        char *key = strtok(line, "=");
        char *value = strtok(NULL, "\\n");
        
        if (key && value) {
            key = strtok(key, " \\t");
            value = strtok(value, " \\t");
            
            if (key && value) {
                for (int i = 0; i < EVENT_COUNT; i++) {
                    if (strcasecmp(key, event_type_names[i]) == 0) {
                        filters[i].enabled = (strcasecmp(value, "enable") == 0) ? 1 : 0;
                        break;
                    }
                }
            }
        }
    }
    
    fclose(config);
}

void check_config_update() {
    time_t now = time(NULL);
    if (now - last_config_check >= CONFIG_CHECK_INTERVAL) {
        load_config();
        last_config_check = now;
    }
}

void signal_handler(int sig) {
    running = 0;
}

char* get_username() {
    struct passwd *pw = getpwuid(getuid());
    return pw ? pw->pw_name : "unknown";
}

void monitor_logins_real_time() {
    static time_t last_check = 0;
    time_t now = time(NULL);
    
    // Only check once per second
    if (now - last_check < 1) {
        return;
    }
    
    last_check = now;
    
    // Only check for new events since program start
    setutxent();
    struct utmpx *ut;
    
    while ((ut = getutxent()) != NULL) {
        // Only process events that happened after program start
        if (ut->ut_tv.tv_sec > program_start_time) {
            system_event_t event;
            strncpy(event.username, ut->ut_user, sizeof(event.username)-1);
            event.username[sizeof(event.username)-1] = '\\0';
            
            // Handle empty host fields
            if (strlen(ut->ut_host) > 0) {
                strncpy(event.source, ut->ut_host, sizeof(event.source)-1);
            } else {
                strncpy(event.source, "local", sizeof(event.source)-1);
            }
            event.source[sizeof(event.source)-1] = '\\0';
            
            event.timestamp = ut->ut_tv.tv_sec;
            
            if (ut->ut_type == USER_PROCESS) {
                if (strlen(ut->ut_host) > 0) {
                    snprintf(event.details, sizeof(event.details), 
                            "Login from %s on %s", ut->ut_host, ut->ut_line);
                } else {
                    snprintf(event.details, sizeof(event.details), 
                            "Local login on %s", ut->ut_line);
                }
                
                event.type = EVENT_LOGIN;
                
                if (filters[EVENT_LOGIN].enabled) {
                    log_event(&event);
                }
            }
            else if (ut->ut_type == DEAD_PROCESS) {
                snprintf(event.details, sizeof(event.details), 
                        "Logout from %s", ut->ut_line);
                event.type = EVENT_LOGOUT;
                
                if (filters[EVENT_LOGOUT].enabled) {
                    log_event(&event);
                }
            }
        }
    }
    endutxent();
}

void setup_file_monitoring(int inotify_fd) {
    char* watch_dirs[] = {
        "/home", "/etc", "/var/log", "/tmp", "/usr", "/opt", NULL
    };
    
    for (int i = 0; watch_dirs[i] != NULL; i++) {
        if (access(watch_dirs[i], F_OK) != -1) {
            int wd = inotify_add_watch(inotify_fd, watch_dirs[i], 
                                      IN_MODIFY | IN_CREATE | IN_DELETE | IN_MOVE);
            if (wd == -1) {
                printf("Warning: Cannot watch directory %s\\n", watch_dirs[i]);
            }
        }
    }
}

void handle_file_event(const struct inotify_event *event, const char* base_path) {
    system_event_t sys_event;
    strncpy(sys_event.username, get_username(), sizeof(sys_event.username)-1);
    sys_event.username[sizeof(sys_event.username)-1] = '\\0';
    
    strncpy(sys_event.source, "FILE_SYSTEM", sizeof(sys_event.source)-1);
    sys_event.source[sizeof(sys_event.source)-1] = '\\0';
    
    sys_event.timestamp = time(NULL);
    
    if (event->mask & IN_MODIFY) {
        snprintf(sys_event.details, sizeof(sys_event.details), 
                "File modified: %s", event->name);
        sys_event.type = EVENT_FILE_EDIT;
        if (filters[EVENT_FILE_EDIT].enabled) log_event(&sys_event);
    }
    if (event->mask & IN_CREATE) {
        snprintf(sys_event.details, sizeof(sys_event.details), 
                "File created: %s", event->name);
        sys_event.type = EVENT_FILE_CREATE;
        if (filters[EVENT_FILE_CREATE].enabled) log_event(&sys_event);
    }
    if (event->mask & IN_DELETE) {
        snprintf(sys_event.details, sizeof(sys_event.details), 
                "File deleted: %s", event->name);
        sys_event.type = EVENT_FILE_DELETE;
        if (filters[EVENT_FILE_DELETE].enabled) log_event(&sys_event);
    }
    if (event->mask & IN_MOVED_FROM) {
        snprintf(sys_event.details, sizeof(sys_event.details), 
                "File moved from: %s", event->name);
        sys_event.type = EVENT_FILE_MOVE;
        if (filters[EVENT_FILE_MOVE].enabled) log_event(&sys_event);
    }
    if (event->mask & IN_MOVED_TO) {
        snprintf(sys_event.details, sizeof(sys_event.details), 
                "File moved to: %s", event->name);
        sys_event.type = EVENT_FILE_MOVE;
        if (filters[EVENT_FILE_MOVE].enabled) log_event(&sys_event);
    }
}

void monitor_ssh_connections() {
    static time_t last_ssh_check = 0;
    time_t now = time(NULL);
    
    if (now - last_ssh_check < 2) {
        return;
    }
    
    last_ssh_check = now;
    
    // Check for SSH processes
    DIR *proc_dir = opendir("/proc");
    if (!proc_dir) return;
    
    struct dirent *entry;
    int ssh_found = 0;
    
    while ((entry = readdir(proc_dir)) != NULL) {
        if (atoi(entry->d_name) > 0) {
            char cmdline_path[256];
            snprintf(cmdline_path, sizeof(cmdline_path), "/proc/%s/cmdline", entry->d_name);
            
            FILE *cmdline = fopen(cmdline_path, "r");
            if (cmdline) {
                char cmdline_content[256];
                if (fgets(cmdline_content, sizeof(cmdline_content), cmdline)) {
                    if (strstr(cmdline_content, "ssh") || strstr(cmdline_content, "sshd")) {
                        ssh_found = 1;
                        fclose(cmdline);
                        break;
                    }
                }
                fclose(cmdline);
            }
        }
    }
    closedir(proc_dir);
    
    if (ssh_found) {
        system_event_t event;
        strncpy(event.username, get_username(), sizeof(event.username)-1);
        event.username[sizeof(event.username)-1] = '\\0';
        
        strncpy(event.source, "SSH", sizeof(event.source)-1);
        event.source[sizeof(event.source)-1] = '\\0';
        
        snprintf(event.details, sizeof(event.details), "SSH connection detected");
        event.type = EVENT_SSH;
        event.timestamp = now;
        
        if (filters[EVENT_SSH].enabled) {
            log_event(&event);
        }
    }
}

void monitor_network_connections() {
    static time_t last_check = 0;
    time_t now = time(NULL);
    
    if (now - last_check < 5) {
        return;
    }
    
    last_check = now;
    
    FILE *net_tcp = fopen("/proc/net/tcp", "r");
    if (!net_tcp) return;
    
    char line[256];
    int connection_count = 0;
    
    fgets(line, sizeof(line), net_tcp); // Skip header
    
    while (fgets(line, sizeof(line), net_tcp)) {
        connection_count++;
    }
    
    fclose(net_tcp);
    
    if (connection_count > 0) {
        system_event_t event;
        strncpy(event.username, get_username(), sizeof(event.username)-1);
        event.username[sizeof(event.username)-1] = '\\0';
        
        strncpy(event.source, "NETWORK", sizeof(event.source)-1);
        event.source[sizeof(event.source)-1] = '\\0';
        
        snprintf(event.details, sizeof(event.details), 
                "Active TCP connections: %d", connection_count);
        event.type = EVENT_NETWORK;
        event.timestamp = now;
        
        if (filters[EVENT_NETWORK].enabled) {
            log_event(&event);
        }
    }
}

void monitor_process_activity() {
    static int last_pid_count = 0;
    static time_t last_check = 0;
    time_t now = time(NULL);
    
    if (now - last_check < 3) {
        return;
    }
    
    last_check = now;
    
    DIR *proc_dir = opendir("/proc");
    if (!proc_dir) return;
    
    int pid_count = 0;
    struct dirent *entry;
    
    while ((entry = readdir(proc_dir)) != NULL) {
        if (atoi(entry->d_name) > 0) {
            pid_count++;
        }
    }
    
    closedir(proc_dir);
    
    if (pid_count != last_pid_count) {
        system_event_t event;
        strncpy(event.username, get_username(), sizeof(event.username)-1);
        event.username[sizeof(event.username)-1] = '\\0';
        
        strncpy(event.source, "PROCESS", sizeof(event.source)-1);
        event.source[sizeof(event.source)-1] = '\\0';
        
        snprintf(event.details, sizeof(event.details), 
                "Process count changed: %d -> %d", last_pid_count, pid_count);
        event.type = EVENT_PROCESS;
        event.timestamp = now;
        
        if (filters[EVENT_PROCESS].enabled) {
            log_event(&event);
        }
        
        last_pid_count = pid_count;
    }
}

void create_sample_config() {
    int config_fd = open(CONFIG_FILE, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (config_fd == -1) {
        printf("Warning: Cannot create config file %s\\n", CONFIG_FILE);
        return;
    }
    
    FILE *config = fdopen(config_fd, "w");
    if (!config) {
        close(config_fd);
        return;
    }
    
    fprintf(config, "# System Monitor Configuration\\n");
    fprintf(config, "# Use 'enable' or 'disable' for each event type\\n\\n");
    
    // Default: disable file events, enable others
    for (int i = 0; i < EVENT_COUNT; i++) {
        if (i == EVENT_FILE_MOVE || i == EVENT_FILE_EDIT || 
            i == EVENT_FILE_CREATE || i == EVENT_FILE_DELETE) {
            fprintf(config, "%s=disable\\n", event_type_names[i]);
        } else {
            fprintf(config, "%s=enable\\n", event_type_names[i]);
        }
    }
    
    fclose(config);
    printf("Sample configuration created at %s\\n", CONFIG_FILE);
}

void initialize_stats() {
    memset(&stats, 0, sizeof(stats));
    stats.last_update = time(NULL);
}

int main(int argc, char *argv[]) {
    printf("System Monitor Starting...\\n");
    
    program_start_time = time(NULL);
    initialize_stats();
    load_self_identifier();
    
    if (getuid() != 0) {
        printf("Warning: Running without root privileges. Some features may not work.\\n");
    }
    
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    log_fd = open(LOG_FILE, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (log_fd == -1) {
        printf("Error: Cannot open log file %s\\n", LOG_FILE);
        return 1;
    }
    
    if (access(CONFIG_FILE, F_OK) == -1) {
        create_sample_config();
    }
    
    // Initialize filters - disable file events by default
    for (int i = 0; i < EVENT_COUNT; i++) {
        filters[i].type = i;
        // Default: enable all except file events
        if (i == EVENT_FILE_MOVE || i == EVENT_FILE_EDIT || 
            i == EVENT_FILE_CREATE || i == EVENT_FILE_DELETE) {
            filters[i].enabled = 0;
        } else {
            filters[i].enabled = 1;
        }
    }
    
    load_config();
    last_config_check = time(NULL);
    
    int inotify_fd = inotify_init();
    if (inotify_fd == -1) {
        printf("Error: Cannot initialize inotify\\n");
        close(log_fd);
        return 1;
    }
    
    setup_file_monitoring(inotify_fd);
    
    printf("Monitoring started at: %s", ctime(&program_start_time));
    printf("Log file: %s\\n", LOG_FILE);
    printf("Configuration: %s\\n", CONFIG_FILE);
    printf("Self-events will be automatically filtered out.\\n");
    printf("Press Ctrl+C to stop monitoring.\\n\\n");
    
    char buffer[BUF_LEN];
    fd_set read_fds;
    struct timeval timeout;
    
    while (running) {
        FD_ZERO(&read_fds);
        FD_SET(inotify_fd, &read_fds);
        
        timeout.tv_sec = 0;
        timeout.tv_usec = 100000; // 100ms timeout for more responsive monitoring
        
        int ready = select(inotify_fd + 1, &read_fds, NULL, NULL, &timeout);
        
        if (ready > 0 && FD_ISSET(inotify_fd, &read_fds)) {
            int length = read(inotify_fd, buffer, BUF_LEN);
            if (length > 0) {
                int i = 0;
                while (i < length) {
                    struct inotify_event *event = (struct inotify_event *)&buffer[i];
                    if (event->len) {
                        handle_file_event(event, "FILE_SYSTEM");
                    }
                    i += EVENT_SIZE + event->len;
                }
            }
        }
        
        // Check for config updates
        check_config_update();
        
        // Monitor various system activities
        monitor_logins_real_time();
        monitor_ssh_connections();
        monitor_network_connections();
        monitor_process_activity();
    }
    
    close(inotify_fd);
    close(log_fd);
    
    printf("\\nSystem Monitor stopped.\\n");
    return 0;
}`;

let monitor_config = 
"#include <stdio.h>\n" +
"#include <stdlib.h>\n" +
"#include <string.h>\n" +
"#include <unistd.h>\n" +
"#include <time.h>\n" +
"#include <sys/stat.h>\n" +
"#include <fcntl.h>\n" +
"#include <sys/file.h>\n" +
"#include <termios.h>\n" +
"#include <signal.h>\n" +
"#include <sys/ioctl.h>\n" +
"\n" +
"#define CONFIG_FILE \"/etc/system_monitor.conf\"\n" +
"#define STATS_FILE \"/tmp/system_monitor_stats\"\n" +
"\n" +
"typedef enum {\n" +
"    EVENT_LOGIN,\n" +
"    EVENT_LOGOUT,\n" +
"    EVENT_SSH,\n" +
"    EVENT_FILE_MOVE,\n" +
"    EVENT_FILE_EDIT,\n" +
"    EVENT_FILE_CREATE,\n" +
"    EVENT_FILE_DELETE,\n" +
"    EVENT_NETWORK,\n" +
"    EVENT_PROCESS,\n" +
"    EVENT_OTHERS,\n" +
"    EVENT_COUNT\n" +
"} event_type_t;\n" +
"\n" +
"const char* event_type_names[] = {\n" +
"    \"LOGIN\", \"LOGOUT\", \"SSH\", \"FILE_MOVE\", \"FILE_EDIT\", \n" +
"    \"FILE_CREATE\", \"FILE_DELETE\", \"NETWORK\", \"PROCESS\", \"OTHERS\"\n" +
"};\n" +
"\n" +
"typedef struct {\n" +
"    int events_second[EVENT_COUNT];\n" +
"    int events_minute[EVENT_COUNT];\n" +
"    int total_events;\n" +
"    time_t last_update;\n" +
"} stats_t;\n" +
"\n" +
"int filters[EVENT_COUNT];\n" +
"stats_t stats;\n" +
"int running = 1;\n" +
"time_t last_display_update = 0;\n" +
"struct termios original_termios;\n" +
"\n" +
"void enable_raw_mode() {\n" +
"    struct termios term;\n" +
"    tcgetattr(STDIN_FILENO, &term);\n" +
"    original_termios = term;\n" +
"    term.c_lflag &= ~(ICANON | ECHO);\n" +
"    tcsetattr(STDIN_FILENO, TCSANOW, &term);\n" +
"}\n" +
"\n" +
"void disable_raw_mode() {\n" +
"    tcsetattr(STDIN_FILENO, TCSANOW, &original_termios);\n" +
"}\n" +
"\n" +
"void clear_screen() {\n" +
"    printf(\"\\033[2J\\033[H\");\n" +
"}\n" +
"\n" +
"void move_cursor_top() {\n" +
"    printf(\"\\033[H\");\n" +
"}\n" +
"\n" +
"void erase_to_end_of_line() {\n" +
"    printf(\"\\033[K\");\n" +
"}\n" +
"\n" +
"void load_config() {\n" +
"    int config_fd = open(CONFIG_FILE, O_RDONLY);\n" +
"    if (config_fd == -1) {\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    if (flock(config_fd, LOCK_SH) == -1) {\n" +
"        close(config_fd);\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    FILE *config = fdopen(config_fd, \"r\");\n" +
"    if (!config) {\n" +
"        close(config_fd);\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    char line[256];\n" +
"    while (fgets(line, sizeof(line), config)) {\n" +
"        if (line[0] == '#' || line[0] == '\\n') continue;\n" +
"        \n" +
"        char *key = strtok(line, \"=\");\n" +
"        char *value = strtok(NULL, \"\\n\");\n" +
"        \n" +
"        if (key && value) {\n" +
"            key = strtok(key, \" \\t\");\n" +
"            value = strtok(value, \" \\t\");\n" +
"            \n" +
"            if (key && value) {\n" +
"                for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"                    if (strcasecmp(key, event_type_names[i]) == 0) {\n" +
"                        filters[i] = (strcasecmp(value, \"enable\") == 0) ? 1 : 0;\n" +
"                        break;\n" +
"                    }\n" +
"                }\n" +
"            }\n" +
"        }\n" +
"    }\n" +
"    \n" +
"    fclose(config);\n" +
"}\n" +
"\n" +
"void save_config() {\n" +
"    int config_fd = open(CONFIG_FILE, O_WRONLY | O_CREAT | O_TRUNC, 0644);\n" +
"    if (config_fd == -1) {\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    if (flock(config_fd, LOCK_EX) == -1) {\n" +
"        close(config_fd);\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    FILE *config = fdopen(config_fd, \"w\");\n" +
"    if (!config) {\n" +
"        close(config_fd);\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    fprintf(config, \"# System Monitor Configuration\\n\");\n" +
"    fprintf(config, \"# Use 'enable' or 'disable' for each event type\\n\\n\");\n" +
"    \n" +
"    for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"        fprintf(config, \"%s=%s\\n\", event_type_names[i], filters[i] ? \"enable\" : \"disable\");\n" +
"    }\n" +
"    \n" +
"    fclose(config);\n" +
"}\n" +
"\n" +
"void load_stats() {\n" +
"    FILE *stats_file = fopen(STATS_FILE, \"r\");\n" +
"    if (stats_file) {\n" +
"        fread(&stats, sizeof(stats), 1, stats_file);\n" +
"        fclose(stats_file);\n" +
"    }\n" +
"}\n" +
"\n" +
"void print_header() {\n" +
"    time_t now = time(NULL);\n" +
"    char timestamp[64];\n" +
"    struct tm *tm_info = localtime(&now);\n" +
"    strftime(timestamp, sizeof(timestamp), \"%H:%M:%S\", tm_info);\n" +
"    \n" +
"    printf(\"=== System Monitor Configuration Interface ===\\n\");\n" +
"    printf(\"Last Update: %s | Total Events: %d\\n\", timestamp, stats.total_events);\n" +
"    erase_to_end_of_line();\n" +
"    printf(\"\\n\");\n" +
"}\n" +
"\n" +
"void print_filters() {\n" +
"    printf(\"Event Filters (Press number to toggle, 's' to save, 'q' to quit):\\n\");\n" +
"    printf(\"┌──────────────────────┬──────────┬─────────────┬─────────────┐\\n\");\n" +
"    printf(\"│ Event Type           │ Status   │ Events/Sec  │ Events/Min  │\\n\");\n" +
"    printf(\"├──────────────────────┼──────────┼─────────────┼─────────────┤\\n\");\n" +
"    \n" +
"    int total_second = 0;\n" +
"    int total_minute = 0;\n" +
"    \n" +
"    for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"        printf(\"│ %2d. %-16s │ %-8s │ %11d │ %11d │\\n\", \n" +
"               i + 1, event_type_names[i], \n" +
"               filters[i] ? \"ENABLED\" : \"DISABLED\",\n" +
"               stats.events_second[i],\n" +
"               stats.events_minute[i]);\n" +
"        erase_to_end_of_line();\n" +
"        \n" +
"        total_second += stats.events_second[i];\n" +
"        total_minute += stats.events_minute[i];\n" +
"    }\n" +
"    printf(\"├──────────────────────┼──────────┼─────────────┼─────────────┤\\n\");\n" +
"    printf(\"│ TOTAL                │          │ %11d │ %11d │\\n\", total_second, total_minute);\n" +
"    erase_to_end_of_line();\n" +
"    printf(\"└──────────────────────┴──────────┴─────────────┴─────────────┘\\n\");\n" +
"    erase_to_end_of_line();\n" +
"}\n" +
"\n" +
"void print_event_rates() {\n" +
"    printf(\"\\nActive Events (last second):\\n\");\n" +
"    erase_to_end_of_line();\n" +
"    int any_events = 0;\n" +
"    \n" +
"    for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"        if (stats.events_second[i] > 0) {\n" +
"            printf(\"  %s: %d/sec\", event_type_names[i], stats.events_second[i]);\n" +
"            if (stats.events_minute[i] > 0) {\n" +
"                printf(\" (%d/min)\", stats.events_minute[i]);\n" +
"            }\n" +
"            printf(\"\\n\");\n" +
"            erase_to_end_of_line();\n" +
"            any_events = 1;\n" +
"        }\n" +
"    }\n" +
"    \n" +
"    if (!any_events) {\n" +
"        printf(\"  No active events\\n\");\n" +
"        erase_to_end_of_line();\n" +
"    }\n" +
"}\n" +
"\n" +
"void print_commands() {\n" +
"    printf(\"\\nCommands: 1-9: Toggle events | 0: Toggle OTHERS | A: Toggle all | S: Save | Q: Quit\\n\");\n" +
"    erase_to_end_of_line();\n" +
"    printf(\"> \");\n" +
"    erase_to_end_of_line();\n" +
"    fflush(stdout);\n" +
"}\n" +
"\n" +
"void update_display() {\n" +
"    time_t now = time(NULL);\n" +
"    \n" +
"    if (now - last_display_update < 1) {\n" +
"        return;\n" +
"    }\n" +
"    \n" +
"    last_display_update = now;\n" +
"    \n" +
"    clear_screen();\n" +
"    print_header();\n" +
"    print_filters();\n" +
"    print_event_rates();\n" +
"    print_commands();\n" +
"}\n" +
"\n" +
"void show_save_message() {\n" +
"    printf(\"\\033[s\");\n" +
"    \n" +
"    printf(\"\\033[20H\");\n" +
"    erase_to_end_of_line();\n" +
"    printf(\"✓ Configuration saved! Press any key to continue...\");\n" +
"    fflush(stdout);\n" +
"    \n" +
"    getchar();\n" +
"    \n" +
"    printf(\"\\033[u\");\n" +
"    erase_to_end_of_line();\n" +
"    printf(\"\\033[20H\");\n" +
"    erase_to_end_of_line();\n" +
"}\n" +
"\n" +
"void signal_handler(int sig) {\n" +
"    running = 0;\n" +
"}\n" +
"\n" +
"int main() {\n" +
"    printf(\"Loading System Monitor Configuration Interface...\\n\");\n" +
"    \n" +
"    for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"        if (i == EVENT_FILE_MOVE || i == EVENT_FILE_EDIT || \n" +
"            i == EVENT_FILE_CREATE || i == EVENT_FILE_DELETE) {\n" +
"            filters[i] = 0;\n" +
"        } else {\n" +
"            filters[i] = 1;\n" +
"        }\n" +
"    }\n" +
"    \n" +
"    load_config();\n" +
"    \n" +
"    signal(SIGINT, signal_handler);\n" +
"    signal(SIGTERM, signal_handler);\n" +
"    \n" +
"    enable_raw_mode();\n" +
"    \n" +
"    printf(\"Press any key to start real-time monitoring...\");\n" +
"    fflush(stdout);\n" +
"    getchar();\n" +
"    \n" +
"    clear_screen();\n" +
"    last_display_update = 0;\n" +
"    \n" +
"    while (running) {\n" +
"        load_config();\n" +
"        load_stats();\n" +
"        update_display();\n" +
"        \n" +
"        struct timeval timeout;\n" +
"        timeout.tv_sec = 0;\n" +
"        timeout.tv_usec = 100000;\n" +
"        \n" +
"        fd_set read_fds;\n" +
"        FD_ZERO(&read_fds);\n" +
"        FD_SET(STDIN_FILENO, &read_fds);\n" +
"        \n" +
"        int ready = select(STDIN_FILENO + 1, &read_fds, NULL, NULL, &timeout);\n" +
"        \n" +
"        if (ready > 0) {\n" +
"            char input = getchar();\n" +
"            \n" +
"            if (input >= '1' && input <= '9') {\n" +
"                int index = input - '1';\n" +
"                if (index < EVENT_COUNT) {\n" +
"                    filters[index] = !filters[index];\n" +
"                    save_config();\n" +
"                    last_display_update = 0;\n" +
"                }\n" +
"            } else if (input == '0') {\n" +
"                filters[EVENT_COUNT-1] = !filters[EVENT_COUNT-1];\n" +
"                save_config();\n" +
"                last_display_update = 0;\n" +
"            } else if (input == 's' || input == 'S') {\n" +
"                save_config();\n" +
"                show_save_message();\n" +
"                last_display_update = 0;\n" +
"            } else if (input == 'q' || input == 'Q') {\n" +
"                break;\n" +
"            } else if (input == 'a' || input == 'A') {\n" +
"                int all_enabled = 1;\n" +
"                for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"                    if (!filters[i]) {\n" +
"                        all_enabled = 0;\n" +
"                        break;\n" +
"                    }\n" +
"                }\n" +
"                \n" +
"                for (int i = 0; i < EVENT_COUNT; i++) {\n" +
"                    filters[i] = !all_enabled;\n" +
"                }\n" +
"                save_config();\n" +
"                last_display_update = 0;\n" +
"            }\n" +
"        }\n" +
"        \n" +
"        usleep(10000);\n" +
"    }\n" +
"    \n" +
"    disable_raw_mode();\n" +
"    clear_screen();\n" +
"    printf(\"Configuration interface closed.\\n\");\n" +
"    \n" +
"    return 0;\n" +
"}";

class SystemMonitor {


    static async Start(){
        await C.run(Monitor)
        return
    }

    static async HUD(){
        await C.run(monitor_config)
        return
    }
    
}

export default SystemMonitor