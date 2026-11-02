require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'stockflow.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 default_low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK(default_low_stock_threshold >= 0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 sku TEXT NOT NULL,
 description TEXT,
 quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
 cost_price REAL,
 selling_price REAL,
 low_stock_threshold INTEGER CHECK(low_stock_threshold IS NULL OR low_stock_threshold >= 0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(organization_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_org ON products(organization_id);
`);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 }
}));
app.use((req, res, next) => { res.locals.user = req.session.user || null; res.locals.flash = req.session.flash || null; delete req.session.flash; next(); });
const flash = (req, type, message) => { req.session.flash = { type, message }; };
const auth = (req, res, next) => req.session.user ? next() : res.redirect('/login');
const orgId = req => req.session.user.organizationId;
const validMoney = v => v === '' ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
const validInt = v => /^\d+$/.test(String(v)) ? Number(v) : NaN;

app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));
app.get('/signup', (req, res) => res.render('signup', { title: 'Create account', error: null }));
app.post('/signup', async (req, res) => {
  const { email, password, confirmPassword, organizationName } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanOrg = String(organizationName || '').trim();
  if (!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail) || password.length < 8 || password !== confirmPassword || !cleanOrg) {
    return res.status(400).render('signup', { title: 'Create account', error: 'Enter a valid email, organization name, and matching password (minimum 8 characters).' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const create = db.transaction(() => {
      const org = db.prepare('INSERT INTO organizations (name) VALUES (?)').run(cleanOrg);
      const user = db.prepare('INSERT INTO users (organization_id,email,password_hash) VALUES (?,?,?)').run(org.lastInsertRowid, cleanEmail, hash);
      return { userId: user.lastInsertRowid, organizationId: org.lastInsertRowid };
    });
    const created = create();
    req.session.user = { id: created.userId, organizationId: created.organizationId, email: cleanEmail, organizationName: cleanOrg };
    res.redirect('/dashboard');
  } catch (e) {
    const message = String(e.message).includes('users.email') ? 'An account with this email already exists.' : 'Could not create account. Please try again.';
    res.status(400).render('signup', { title: 'Create account', error: message });
  }
});
app.get('/login', (req, res) => res.render('login', { title: 'Sign in', error: null }));
app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare(`SELECT u.*, o.name AS organization_name FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.email=?`).get(email);
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Email or password is incorrect.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).send('Unable to start session.');
    req.session.user = { id: user.id, organizationId: user.organization_id, email: user.email, organizationName: user.organization_name };
    res.redirect('/dashboard');
  });
});
app.post('/logout', auth, (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/dashboard', auth, (req, res) => {
  const id = orgId(req);
  const stats = db.prepare(`SELECT COUNT(*) AS product_count, COALESCE(SUM(quantity),0) AS units FROM products WHERE organization_id=?`).get(id);
  const lowStock = db.prepare(`SELECT id,name,sku,quantity,COALESCE(low_stock_threshold,(SELECT default_low_stock_threshold FROM organizations WHERE id=?)) AS threshold FROM products WHERE organization_id=? AND quantity <= COALESCE(low_stock_threshold,(SELECT default_low_stock_threshold FROM organizations WHERE id=?)) ORDER BY quantity ASC LIMIT 8`).all(id,id,id);
  res.render('dashboard', { title: 'Dashboard', stats, lowStock, active: 'dashboard' });
});
app.get('/products', auth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const products = q
    ? db.prepare('SELECT * FROM products WHERE organization_id=? AND (name LIKE ? OR sku LIKE ?) ORDER BY updated_at DESC').all(orgId(req), `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM products WHERE organization_id=? ORDER BY updated_at DESC').all(orgId(req));
  const threshold = db.prepare('SELECT default_low_stock_threshold FROM organizations WHERE id=?').get(orgId(req)).default_low_stock_threshold;
  res.render('products', { title: 'Products', products, q, threshold, active: 'products' });
});
function productForm(req, res, product, error = null) { res.render('product-form', { title: product ? 'Edit product' : 'Add product', product: product || {}, error, active: 'products' }); }
app.get('/products/new', auth, (req, res) => productForm(req, res, null));
app.post('/products', auth, (req, res) => {
  const p = req.body; const name = String(p.name || '').trim(); const sku = String(p.sku || '').trim();
  const quantity = validInt(p.quantity); const cost = validMoney(p.costPrice); const selling = validMoney(p.sellingPrice);
  const threshold = p.lowStockThreshold === '' ? null : validInt(p.lowStockThreshold);
  const product = { ...p, name, sku };
  if (!name || !sku || !Number.isInteger(quantity) || [cost,selling,threshold].some(Number.isNaN)) return productForm(req,res,product,'Please enter a name, SKU, valid non-negative quantity, prices and threshold.');
  try {
    db.prepare(`INSERT INTO products (organization_id,name,sku,description,quantity,cost_price,selling_price,low_stock_threshold) VALUES (?,?,?,?,?,?,?,?)`)
      .run(orgId(req),name,sku,String(p.description || '').trim() || null,quantity,cost,selling,threshold);
    flash(req,'success','Product created successfully.'); res.redirect('/products');
  } catch(e) { productForm(req,res,product, String(e.message).includes('UNIQUE') ? 'That SKU already exists in your organization.' : 'Could not save product.'); }
});
app.get('/products/:id/edit', auth, (req,res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=? AND organization_id=?').get(req.params.id,orgId(req));
  if (!p) return res.status(404).render('404',{title:'Not found'}); productForm(req,res,p);
});
app.post('/products/:id', auth, (req,res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id=? AND organization_id=?').get(req.params.id,orgId(req));
  if (!existing) return res.status(404).render('404',{title:'Not found'});
  const p=req.body; const name=String(p.name||'').trim(); const sku=String(p.sku||'').trim();
  const quantity=validInt(p.quantity), cost=validMoney(p.costPrice), selling=validMoney(p.sellingPrice);
  const threshold=p.lowStockThreshold===''?null:validInt(p.lowStockThreshold);
  const product={...p,id:existing.id,name,sku};
  if(!name||!sku||!Number.isInteger(quantity)||[cost,selling,threshold].some(Number.isNaN)) return productForm(req,res,product,'Please enter valid product details.');
  try {
    db.prepare(`UPDATE products SET name=?,sku=?,description=?,quantity=?,cost_price=?,selling_price=?,low_stock_threshold=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
      .run(name,sku,String(p.description||'').trim()||null,quantity,cost,selling,threshold,existing.id,orgId(req));
    flash(req,'success','Product updated successfully.'); res.redirect('/products');
  } catch(e) { productForm(req,res,product,String(e.message).includes('UNIQUE')?'That SKU already exists in your organization.':'Could not update product.'); }
});
app.post('/products/:id/delete', auth, (req,res) => {
  db.prepare('DELETE FROM products WHERE id=? AND organization_id=?').run(req.params.id,orgId(req));
  flash(req,'success','Product deleted.'); res.redirect('/products');
});
app.get('/settings',auth,(req,res)=>{
  const settings=db.prepare('SELECT name,default_low_stock_threshold FROM organizations WHERE id=?').get(orgId(req));
  res.render('settings',{title:'Settings',settings,error:null,active:'settings'});
});
app.post('/settings',auth,(req,res)=>{
  const threshold=validInt(req.body.defaultThreshold);
  const settings={...db.prepare('SELECT name,default_low_stock_threshold FROM organizations WHERE id=?').get(orgId(req)),default_low_stock_threshold:req.body.defaultThreshold};
  if(!Number.isInteger(threshold)) return res.status(400).render('settings',{title:'Settings',settings,error:'Threshold must be a whole number greater than or equal to zero.',active:'settings'});
  db.prepare('UPDATE organizations SET default_low_stock_threshold=? WHERE id=?').run(threshold,orgId(req));
  flash(req,'success','Settings saved.'); res.redirect('/settings');
});
app.use((req,res)=>res.status(404).render('404',{title:'Not found'}));
app.listen(PORT,()=>console.log(`StockFlow running at http://localhost:${PORT}`));
