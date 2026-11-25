export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity: {
        Row: {
          board_id: string
          created_at: string
          id: number
          payload: Json
          type: string
          user_id: string | null
        }
        Insert: {
          board_id: string
          created_at?: string
          id?: never
          payload?: Json
          type: string
          user_id?: string | null
        }
        Update: {
          board_id?: string
          created_at?: string
          id?: never
          payload?: Json
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          token_hash: string
          user_id: string
          workspace_scope: string[] | null
          allowed_ops: string[] | null
          workspace_ops: Record<string, string[]> | null
        }
        Insert: {
          workspace_ops?: Record<string, string[]> | null
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          token_hash: string
          user_id: string
          workspace_scope?: string[] | null
          allowed_ops?: string[] | null
        }
        Update: {
          workspace_ops?: Record<string, string[]> | null
          workspace_scope?: string[] | null
          allowed_ops?: string[] | null
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      board_access: {
        Row: {
          access: string
          board_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          access: string
          board_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          access?: string
          board_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_access_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_access_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      board_counters: {
        Row: {
          board_id: string
          next_number: number
        }
        Insert: {
          board_id: string
          next_number: number
        }
        Update: {
          board_id?: string
          next_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "board_counters_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: true
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      board_messages: {
        Row: {
          agent: boolean
          board_id: string
          body: string
          client_op: string | null
          created_at: string
          deleted_as: string | null
          deleted_as_team_id: string | null
          deleted_at: string | null
          deleted_by: string | null
          edited_at: string | null
          id: string
          seq: number
          user_id: string
        }
        Insert: {
          agent?: boolean
          board_id: string
          body: string
          client_op?: string | null
          created_at?: string
          deleted_as?: string | null
          deleted_as_team_id?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          edited_at?: string | null
          id?: string
          seq: number
          user_id: string
        }
        Update: {
          board_id?: string
          body?: string
          client_op?: string | null
          created_at?: string
          deleted_as?: string | null
          deleted_as_team_id?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          edited_at?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_messages_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_messages_deleted_as_team_id_fkey"
            columns: ["deleted_as_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_messages_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      board_revisions: {
        Row: {
          board_id: string
          revision: number
        }
        Insert: {
          board_id: string
          revision?: number
        }
        Update: {
          board_id?: string
          revision?: number
        }
        Relationships: [
          {
            foreignKeyName: "board_revisions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: true
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      board_team_access: {
        Row: {
          access: string
          board_id: string
          created_at: string
          team_id: string
        }
        Insert: {
          access: string
          board_id: string
          created_at?: string
          team_id: string
        }
        Update: {
          access?: string
          board_id?: string
          created_at?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_team_access_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_team_access_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      boards: {
        Row: {
          access_delegation: boolean
          client_op: string | null
          created_at: string
          description: string
          id: string
          name: string
          owner_id: string
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          access_delegation?: boolean
          client_op?: string | null
          created_at?: string
          description?: string
          id?: string
          name: string
          owner_id: string
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          access_delegation?: boolean
          client_op?: string | null
          created_at?: string
          description?: string
          id?: string
          name?: string
          owner_id?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "boards_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boards_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      card_assignees: {
        Row: {
          assigned_at: string
          card_id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          card_id: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          card_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_assignees_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_assignees_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      card_attachments: {
        Row: {
          card_id: string
          content_type: string | null
          created_at: string
          filename: string
          id: string
          size_bytes: number | null
          storage_path: string
          user_id: string
        }
        Insert: {
          card_id: string
          content_type?: string | null
          created_at?: string
          filename: string
          id?: string
          size_bytes?: number | null
          storage_path: string
          user_id: string
        }
        Update: {
          card_id?: string
          content_type?: string | null
          created_at?: string
          filename?: string
          id?: string
          size_bytes?: number | null
          storage_path?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_attachments_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_attachments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      card_comments: {
        Row: {
          agent: boolean
          body: string
          card_id: string
          client_op: string | null
          created_at: string
          deleted_as: string | null
          deleted_as_team_id: string | null
          deleted_at: string | null
          deleted_by: string | null
          edited_at: string | null
          id: string
          seq: number
          user_id: string
        }
        Insert: {
          agent?: boolean
          body: string
          card_id: string
          client_op?: string | null
          created_at?: string
          deleted_as?: string | null
          deleted_as_team_id?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          edited_at?: string | null
          id?: string
          seq: number
          user_id: string
        }
        Update: {
          body?: string
          card_id?: string
          client_op?: string | null
          created_at?: string
          deleted_as?: string | null
          deleted_as_team_id?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          edited_at?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_comments_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_comments_deleted_as_team_id_fkey"
            columns: ["deleted_as_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_comments_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      card_events: {
        Row: {
          agent: boolean
          actor_id: string | null
          board_id: string
          card_id: string
          created_at: string
          detail: Json
          id: string
          kind: string
        }
        Insert: {
          agent?: boolean
          actor_id?: string | null
          board_id: string
          card_id: string
          created_at?: string
          detail?: Json
          id?: string
          kind: string
        }
        Update: {
          actor_id?: string | null
          board_id?: string
          card_id?: string
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_events_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_events_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
        ]
      }
      card_tags: {
        Row: {
          card_id: string
          tag_id: string
        }
        Insert: {
          card_id: string
          tag_id: string
        }
        Update: {
          card_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_tags_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      cards: {
        Row: {
          board_id: string
          client_op: string | null
          created_at: string
          created_by: string | null
          description: string
          id: string
          list_id: string
          number: number | null
          position: number
          priority: string | null
          resolved_at: string | null
          resolved_by: string | null
          title: string
          updated_at: string
        }
        Insert: {
          board_id: string
          client_op?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          list_id: string
          number?: number | null
          position?: number
          priority?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          board_id?: string
          client_op?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          list_id?: string
          number?: number | null
          position?: number
          priority?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cards_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cards_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cards_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cards_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_prefs: {
        Row: {
          level: string
          scope_id: string
          scope_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          level?: string
          scope_id: string
          scope_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          level?: string
          scope_id?: string
          scope_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_prefs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lists: {
        Row: {
          board_id: string
          client_op: string | null
          created_at: string
          description: string
          id: string
          name: string
          position: number
        }
        Insert: {
          board_id: string
          client_op?: string | null
          created_at?: string
          description?: string
          id?: string
          name: string
          position?: number
        }
        Update: {
          board_id?: string
          client_op?: string | null
          created_at?: string
          description?: string
          id?: string
          name?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "lists_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_auth_codes: {
        Row: {
          challenge_method: string
          client_id: string
          code_challenge: string
          code_hash: string
          created_at: string
          expires_at: string
          id: string
          redirect_uri: string
          used_at: string | null
          user_id: string
          connection_name: string | null
          workspace_scope: string[] | null
          allowed_ops: string[] | null
          workspace_ops: Record<string, string[]> | null
        }
        Insert: {
          connection_name?: string | null
          workspace_ops?: Record<string, string[]> | null
          challenge_method?: string
          client_id: string
          code_challenge: string
          code_hash: string
          expires_at?: string
          id?: string
          redirect_uri: string
          used_at?: string | null
          user_id: string
          workspace_scope?: string[] | null
          allowed_ops?: string[] | null
        }
        Update: {
          [_ in never]: never
        }
        Relationships: []
      }
      notifications: {
        Row: {
          agent: boolean
          actor_id: string | null
          board_id: string | null
          body: string | null
          card_id: string | null
          created_at: string
          href: string | null
          id: string
          kind: string
          seen_at: string | null
          subject_id: string | null
          subject_team_id: string | null
          user_id: string
        }
        Insert: {
          agent?: boolean
          actor_id?: string | null
          board_id?: string | null
          body?: string | null
          card_id?: string | null
          created_at?: string
          href?: string | null
          id?: string
          kind: string
          seen_at?: string | null
          subject_id?: string | null
          subject_team_id?: string | null
          user_id: string
        }
        Update: {
          actor_id?: string | null
          board_id?: string | null
          body?: string | null
          card_id?: string | null
          created_at?: string
          href?: string | null
          id?: string
          kind?: string
          seen_at?: string | null
          subject_id?: string | null
          subject_team_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_subject_team_id_fkey"
            columns: ["subject_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          email: string
          has_passkey: boolean
          id: string
          theme: string
          username: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          email: string
          has_passkey?: boolean
          id: string
          theme?: string
          username?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          email?: string
          has_passkey?: boolean
          id?: string
          theme?: string
          username?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          created_at: string
          description: string
          id: string
          name: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          name: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          name?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tags_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          created_at: string
          role: string
          team_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          team_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          role?: string
          team_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          deactivated_at: string | null
          description: string
          id: string
          name: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          deactivated_at?: string | null
          description?: string
          id?: string
          name: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          deactivated_at?: string | null
          description?: string
          id?: string
          name?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_status: {
        Row: {
          clear_at: string | null
          dnd: boolean
          emoji: string | null
          label: string | null
          presets: Json
          updated_at: string
          user_id: string
          work_end: string | null
          work_start: string | null
          workdays: number[]
        }
        Insert: {
          clear_at?: string | null
          dnd?: boolean
          emoji?: string | null
          label?: string | null
          presets?: Json
          updated_at?: string
          user_id: string
          work_end?: string | null
          work_start?: string | null
          workdays?: number[]
        }
        Update: {
          clear_at?: string | null
          dnd?: boolean
          emoji?: string | null
          label?: string | null
          presets?: Json
          updated_at?: string
          user_id?: string
          work_end?: string | null
          work_start?: string | null
          workdays?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "user_status_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_counters: {
        Row: {
          next_number: number
          workspace_id: string
        }
        Insert: {
          next_number: number
          workspace_id: string
        }
        Update: {
          next_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_counters_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invites: {
        Row: {
          created_at: string
          email: string
          id: string
          invited_by: string | null
          role: string
          status: string
          token: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          invited_by?: string | null
          role?: string
          status?: string
          token?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          invited_by?: string | null
          role?: string
          status?: string
          token?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          board_creation: string
          created_at: string
          id: string
          invite_domains: string[]
          name: string
          owner_id: string
          slug: string
        }
        Insert: {
          board_creation?: string
          created_at?: string
          id?: string
          invite_domains?: string[]
          name: string
          owner_id: string
          slug: string
        }
        Update: {
          board_creation?: string
          created_at?: string
          id?: string
          invite_domains?: string[]
          name?: string
          owner_id?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_workspace_invite: { Args: { p_token: string }; Returns: string }
      allocate_card_position: { Args: { p_list_id: string }; Returns: number }
      allocate_chat_seq: { Args: { p_kind: string; p_scope: string }; Returns: number }
      allocate_list_position: { Args: { p_board_id: string }; Returns: number }
      auth_check_email: { Args: { p_email: string }; Returns: Json }
      board_card_comment_stats: {
        Args: { p_board_id: string }
        Returns: {
          card_id: string
          comment_count: number
          last_comment_at: string
        }[]
      }
      delete_board_message: { Args: { p_id: string }; Returns: Json }
      delete_comment: { Args: { p_id: string }; Returns: Json }
      log_card_mentions: {
        Args: {
          p_body: string
          p_actor: string
          p_where: string
          p_board_id: string
          p_card_id?: string
          p_source_id?: string
        }
        Returns: number
      }
      purge_board: { Args: { p_board_id: string }; Returns: Json }
      resolve_card: { Args: { p_card_id: string }; Returns: Json }
      unresolve_card: { Args: { p_card_id: string }; Returns: Json }
      get_chat_seen: {
        Args: { p_scope_id: string; p_scope_type: string }
        Returns: string
      }
      mark_chat_seen: {
        Args: { p_scope_id: string; p_scope_type: string; p_seen_at?: string }
        Returns: string
      }
      mcp_exec: {
        Args: { p_arg?: Json; p_op: string; p_user_id: string }
        Returns: Json
      }
      user_board_access: { Args: { p_board_id: string }; Returns: string }
      user_board_role: { Args: { p_board_id: string }; Returns: string }
      user_is_team_admin_on_board: {
        Args: { p_board_id: string }
        Returns: boolean
      }
      user_team_role: { Args: { p_team_id: string }; Returns: string }
      user_workspace_role: { Args: { p_workspace_id: string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
