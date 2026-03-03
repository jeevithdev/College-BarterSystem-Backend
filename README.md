# Valrix - Backend

A backend system for a general-purpose barter and exchange platform that enables users to trade goods with one another without direct monetary transactions. The platform provides structured item listings, a hybrid trade + chat system with secure transaction-based workflows, and enterprise-grade safeguards against race conditions.

##  Features

###  Authentication & Authorization
- User registration and login with password reset functionality
- JWT-based authentication
- Ownership-based access control
- Email service integration for password recovery

###  Item Management
- Create, update, and delete item listings
- Categorization and condition tracking (electronics, accessories, books, vehicles, etc.)
- Item status tracking (available, traded)
- Ownership validation and transfer

###  Hybrid Trade + Chat System

**Multi-stage Trade Lifecycle:**
- Proposed  Negotiating  Confirmed  Completed
- Owner-driven confirmation authority
- Automatic conversation creation on trade request
- Item locking during confirmation phase
- Atomic ownership swaps with MongoDB transactions

**Race Condition Prevention:**
- Transaction-based multi-document updates
- Atomic state transitions with findOneAndUpdate
- Competing trade rejection on confirmation
- Double-completion prevention

**Real-time Chat Integration:**
- Conversation auto-linked to trades
- Message read tracking
- Participant-only access control
- Last message tracking

###  System Design
- RESTful API architecture
- MVC-style modular structure
- MongoDB Atlas with transaction support
- Production-ready error handling
- Atomic database operations

##  Tech Stack
- **Backend:** Node.js, Express.js
- **Database:** MongoDB (Mongoose ODM)
- **Authentication:** JSON Web Tokens (JWT)
- **Architecture:** MVC-style modular backend

##  Project Structure
```
src/
 controllers/
    authController.js
    itemController.js
    tradeController.js
    conversationController.js
 models/
    User.js
    Item.js
    Trade.js
    Conversation.js
    Message.js
 routes/
    auth.js
    itemRoutes.js
    tradeRoutes.js
    conversationRoutes.js
 middleware/
    authMiddleware.js
 utils/
    emailService.js
 app.js
 server.js
```

##  API Endpoints

### Authentication (`/api/auth`)
- `POST /register` - Create new user account
- `POST /login` - User login
- `POST /forgot-password` - Request password reset
- `POST /reset-password` - Reset password with token

### Items (`/api/items`)
- `GET /` - List all available items
- `GET /:id` - Get item details
- `POST /` - Create new item
- `PUT /:id` - Update item
- `DELETE /:id` - Delete item

### Trades (`/api/trades`)
- `POST /request` - Create trade request (status: proposed)
- `GET /myrequests` - Get trades initiated by user
- `GET /requests-for-me` - Get trades received by user
- `POST /:id/interest` - Express interest (proposed  negotiating)
- `POST /:id/confirm` - Confirm trade (negotiating  confirmed, locks items)
- `POST /:id/complete` - Complete trade (confirmed  completed, swaps ownership)
- `POST /:id/reject` - Reject trade

### Conversations (`/api/conversations`)
- `GET /` - Get all user conversations
- `GET /:id` - Get specific conversation
- `POST /:id/messages` - Send message
- `GET /:id/messages` - Get conversation messages
- `POST /:id/read` - Mark messages as read

##  Data Models

### User
- name, email, password (hashed)
- resetPasswordToken, resetPasswordExpires
- profileImage
- timestamps

### Item
- title, description, category, condition
- images (array)
- lookingFor (item_swap, credits, flexible)
- status (available, traded)
- owner (ref: User)
- timestamps

### Trade
- offeredItem, requestedItem (ref: Item)
- requester, owner (ref: User)
- status (proposed, negotiating, confirmed, completed, rejected)
- completedAt
- timestamps

### Conversation
- participants (array of User refs)
- trade (ref: Trade)
- lastMessage (ref: Message)
- timestamps

### Message
- conversation (ref: Conversation)
- sender (ref: User)
- text
- readBy (array of User refs)
- timestamps

##  Trade Workflow

1. **Propose Trade** - User creates trade request (status: proposed)
   - Validates item availability
   - Prevents self-trading
   - Auto-creates conversation
   - No item locking

2. **Express Interest** - Owner shows interest (status: negotiating)
   - Only owner can call
   - Opens negotiation phase
   - Users can chat via conversation

3. **Confirm Trade** - Owner confirms (status: confirmed)
   - **Locks both items atomically**
   - Rejects competing trades
   - Uses MongoDB transactions
   - Prevents race conditions

4. **Complete Trade** - Either party completes (status: completed)
   - Swaps item ownership atomically
   - Prevents double completion
   - Items remain in "traded" status

5. **Reject Trade** - Owner rejects at any time before confirmation

##  Project Status

 Hybrid trade + chat system fully implemented  
 Transaction-based atomic operations  
 Race condition prevention  
 Production-ready error handling  
 RESTful API with comprehensive endpoints  
 Conversation system integrated with trades  

##  Future Enhancements

- WebSocket integration for real-time chat
- User reputation and review system
- Image upload service integration
- Push notifications
- Location-based filtering
- Admin moderation dashboard
- Trade history analytics

##  Security Features

- MongoDB transactions for data integrity
- JWT-based authentication
- Password hashing with bcrypt
- Atomic operations to prevent race conditions
- Authorization checks on all protected routes
- Email token-based password reset
- Participant validation for conversations

##  Purpose

This project demonstrates:

**Advanced Backend Development:**
- Transaction-based database operations
- Race condition prevention
- Multi-stage workflow implementation
- Real-time messaging architecture

**Production-Ready Practices:**
- Proper error handling with rollbacks
- Atomic state transitions
- Authorization and validation
- Scalable RESTful API design

Suitable for senior backend roles, full-stack positions, and demonstrating expertise in complex system design.
