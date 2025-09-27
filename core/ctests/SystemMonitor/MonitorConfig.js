let MonitorConfig = 
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

export default MonitorConfig